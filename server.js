const express    = require('express');
const cors       = require('cors');
const multer     = require('multer');
const path       = require('path');
const { Pool }   = require('pg');
const cloudinary = require('cloudinary').v2;

const app  = express();
const PORT = process.env.PORT || 8080;

/* ════════════════════════════════════════
   PostgreSQL
════════════════════════════════════════ */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

/* ════════════════════════════════════════
   Cloudinary
════════════════════════════════════════ */
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

app.use(cors());
app.use(express.json());

/* ════════════════════════════════════════
   Multer (memory)
════════════════════════════════════════ */
const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    const allowed = ['.jpg','.jpeg','.png','.webp','.gif'];
    const ext = path.extname(file.originalname).toLowerCase();
    allowed.includes(ext) ? cb(null, true) : cb(new Error('รองรับเฉพาะไฟล์ภาพ'));
  },
  limits: { fileSize: 5 * 1024 * 1024 },
});

async function uploadToCloudinary(buffer, sku) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { public_id: `stock/${sku}`, overwrite: true, resource_type: 'image' },
      (err, result) => err ? reject(err) : resolve(result.secure_url)
    );
    stream.end(buffer);
  });
}

async function deleteFromCloudinary(sku) {
  try { await cloudinary.uploader.destroy(`stock/${sku}`); } catch {}
}

/* ════════════════════════════════════════
   สร้างตารางถ้ายังไม่มี
════════════════════════════════════════ */
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS products (
      sku        VARCHAR(50)  PRIMARY KEY,
      name       VARCHAR(255) NOT NULL,
      unit       VARCHAR(50)  NOT NULL DEFAULT 'ชิ้น',
      stock      INTEGER      NOT NULL DEFAULT 0,
      min_stock  INTEGER      NOT NULL DEFAULT 5,
      image_url  TEXT         NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS transactions (
      id         SERIAL       PRIMARY KEY,
      type       VARCHAR(3)   NOT NULL,
      sku        VARCHAR(50)  NOT NULL REFERENCES products(sku) ON DELETE CASCADE,
      qty        INTEGER      NOT NULL,
      balance    INTEGER      NOT NULL,
      person     VARCHAR(255),
      note       TEXT,
      created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    );
  `);
  console.log('✅ Database tables ready');
}

/* ════════════════════════════════════════
   Health check
════════════════════════════════════════ */
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'connected', time: new Date() });
  } catch(e) { res.status(500).json({ status: 'error', message: e.message }); }
});

/* ════════════════════════════════════════
   SUMMARY
════════════════════════════════════════ */
app.get('/api/summary', async (req, res) => {
  try {
    const [p, ti, to, ls, os] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM products'),
      pool.query("SELECT COALESCE(SUM(qty),0) AS t FROM transactions WHERE type='in'"),
      pool.query("SELECT COALESCE(SUM(qty),0) AS t FROM transactions WHERE type='out'"),
      pool.query('SELECT COUNT(*) FROM products WHERE stock > 0 AND stock <= min_stock'),
      pool.query('SELECT COUNT(*) FROM products WHERE stock = 0'),
    ]);
    res.json({
      total_products: parseInt(p.rows[0].count),
      total_in:       parseInt(ti.rows[0].t),
      total_out:      parseInt(to.rows[0].t),
      low_stock:      parseInt(ls.rows[0].count),
      out_of_stock:   parseInt(os.rows[0].count),
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

/* ════════════════════════════════════════
   PRODUCTS
════════════════════════════════════════ */
app.get('/api/products', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT sku, name, unit, stock, min_stock AS "minStock", image_url AS "imageUrl" FROM products ORDER BY name');
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/products', upload.single('image'), async (req, res) => {
  try {
    const { sku, name, unit='ชิ้น', stock=0, minStock=5 } = req.body;
    if (!sku || !name) return res.status(400).json({ error: 'sku และ name จำเป็นต้องมี' });

    let imageUrl = '';
    if (req.file) imageUrl = await uploadToCloudinary(req.file.buffer, sku.trim());

    const { rows } = await pool.query(
      `INSERT INTO products (sku, name, unit, stock, min_stock, image_url)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [sku.trim(), name.trim(), unit.trim(), Number(stock), Number(minStock), imageUrl]
    );
    res.status(201).json({ ...rows[0], minStock: rows[0].min_stock, imageUrl: rows[0].image_url });
  } catch(e) {
    if (e.code === '23505') return res.status(409).json({ error: 'รหัสสินค้านี้มีอยู่แล้ว' });
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/products/:sku/image', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'ไม่พบไฟล์รูปภาพ' });
    const imageUrl = await uploadToCloudinary(req.file.buffer, req.params.sku);
    await pool.query('UPDATE products SET image_url=$1 WHERE sku=$2', [imageUrl, req.params.sku]);
    res.json({ message: 'อัปเดตรูปภาพสำเร็จ', imageUrl });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/products/:sku/image', async (req, res) => {
  try {
    await deleteFromCloudinary(req.params.sku);
    await pool.query('UPDATE products SET image_url=$1 WHERE sku=$2', ['', req.params.sku]);
    res.json({ message: 'ลบรูปภาพสำเร็จ' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/products/:sku', async (req, res) => {
  try {
    await deleteFromCloudinary(req.params.sku);
    const { rowCount } = await pool.query('DELETE FROM products WHERE sku=$1', [req.params.sku]);
    if (!rowCount) return res.status(404).json({ error: 'ไม่พบสินค้า' });
    res.json({ message: 'ลบสำเร็จ' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

/* ════════════════════════════════════════
   TRANSACTIONS
════════════════════════════════════════ */
app.get('/api/transactions', async (req, res) => {
  try {
    const { search='', type='' } = req.query;
    const conditions = ['1=1'];
    const params = [];
    if (type)   { params.push(type);   conditions.push(`t.type=$${params.length}`); }
    if (search) { params.push(`%${search}%`); conditions.push(`(p.name ILIKE $${params.length} OR t.sku ILIKE $${params.length} OR t.note ILIKE $${params.length})`); }

    const { rows } = await pool.query(
      `SELECT t.id, t.type, t.sku, p.name, t.qty, t.balance, t.person, t.note,
              t.created_at AS date, p.unit, p.image_url AS "imageUrl"
       FROM transactions t JOIN products p ON t.sku=p.sku
       WHERE ${conditions.join(' AND ')}
       ORDER BY t.created_at DESC LIMIT 200`,
      params
    );
    res.json({ data: rows, total: rows.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/transactions', async (req, res) => {
  const client = await pool.connect();
  try {
    const { type, sku, qty, person='', note='' } = req.body;
    if (!type||!sku||!qty) return res.status(400).json({ error: 'type, sku, qty จำเป็นต้องมี' });
    if (!['in','out'].includes(type)) return res.status(400).json({ error: 'type ต้องเป็น in หรือ out' });
    if (Number(qty)<=0) return res.status(400).json({ error: 'qty ต้องมากกว่า 0' });

    await client.query('BEGIN');
    const { rows: pr } = await client.query('SELECT * FROM products WHERE sku=$1 FOR UPDATE', [sku]);
    if (!pr.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'ไม่พบสินค้า' }); }

    const prod = pr[0];
    const numQty = Number(qty);
    if (type==='out' && prod.stock < numQty) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `สต็อกไม่เพียงพอ (มี ${prod.stock} ${prod.unit})` });
    }

    const newStock = type==='in' ? prod.stock+numQty : prod.stock-numQty;
    await client.query('UPDATE products SET stock=$1 WHERE sku=$2', [newStock, sku]);
    const { rows: tr } = await client.query(
      `INSERT INTO transactions (type,sku,qty,balance,person,note) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [type, sku, numQty, newStock, person, note]
    );
    await client.query('COMMIT');

    res.status(201).json({
      transaction: { ...tr[0], name: prod.name, unit: prod.unit, imageUrl: prod.image_url, date: tr[0].created_at },
      new_stock: newStock,
    });
  } catch(e) { await client.query('ROLLBACK'); res.status(500).json({ error: e.message }); }
  finally { client.release(); }
});

app.delete('/api/transactions/:id', async (req, res) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM transactions WHERE id=$1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'ไม่พบรายการ' });
    res.json({ message: 'ลบสำเร็จ' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

/* ════════════════════════════════════════
   Serve React
════════════════════════════════════════ */
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/* ════════════════════════════════════════
   Start
════════════════════════════════════════ */
initDB().then(() => {
  app.listen(PORT, () => {
    console.log('');
    console.log('✅ Stock Backend พร้อมใช้งานแล้ว!');
    console.log(`   PORT:      ${PORT}`);
    console.log(`   Cloudinary: ${process.env.CLOUDINARY_CLOUD_NAME || 'ไม่ได้ตั้งค่า'}`);
    console.log(`   Database:  PostgreSQL`);
    console.log('');
  });
}).catch(err => {
  console.error('❌ Database init failed:', err.message);
  process.exit(1);
});
