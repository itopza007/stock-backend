const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const cloudinary = require('cloudinary').v2;

const app = express();
const PORT = process.env.PORT || 8080;
const JWT_SECRET = process.env.JWT_SECRET || 'stockflow-secret-key-2024';

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
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

/* ════════════════════════════════════════
   Multer
════════════════════════════════════════ */
const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
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
  try { await cloudinary.uploader.destroy(`stock/${sku}`); } catch { }
}

/* ════════════════════════════════════════
   Init Database
════════════════════════════════════════ */
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id         SERIAL       PRIMARY KEY,
      username   VARCHAR(100) UNIQUE NOT NULL,
      password   TEXT         NOT NULL,
      role       VARCHAR(20)  NOT NULL DEFAULT 'staff',
      name       VARCHAR(255),
      created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    );
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

  // สร้าง admin เริ่มต้น ถ้ายังไม่มี
  const { rows } = await pool.query("SELECT id FROM users WHERE username='admin'");
  if (!rows.length) {
    const hash = await bcrypt.hash('admin1234', 10);
    await pool.query(
      "INSERT INTO users (username, password, role, name) VALUES ('admin', $1, 'admin', 'ผู้ดูแลระบบ')",
      [hash]
    );
    console.log('✅ สร้าง admin เริ่มต้น: username=admin password=admin1234');
  }
  console.log('✅ Database tables ready');
}

/* ════════════════════════════════════════
   Auth Middleware
════════════════════════════════════════ */
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'กรุณา Login ก่อน' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token หมดอายุ กรุณา Login ใหม่' });
  }
}

function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'เฉพาะ Admin เท่านั้น' });
  next();
}

/* ════════════════════════════════════════
   Health check
════════════════════════════════════════ */
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'connected', time: new Date() });
  } catch (e) { res.status(500).json({ status: 'error', message: e.message }); }
});

/* ════════════════════════════════════════
   AUTH API
════════════════════════════════════════ */

// POST /api/auth/login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'กรุณากรอก username และ password' });

    const { rows } = await pool.query('SELECT * FROM users WHERE username=$1', [username]);
    if (!rows.length) return res.status(401).json({ error: 'ไม่พบผู้ใช้นี้ในระบบ' });

    const user = rows[0];
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: 'รหัสผ่านไม่ถูกต้อง' });

    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role, name: user.name },
      JWT_SECRET,
      { expiresIn: '8h' }
    );

    res.json({ token, user: { id: user.id, username: user.username, role: user.role, name: user.name } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/auth/me — ตรวจสอบ token
app.get('/api/auth/me', authMiddleware, (req, res) => {
  res.json({ user: req.user });
});

/* ════════════════════════════════════════
   USERS API (admin only)
════════════════════════════════════════ */

// GET /api/users
app.get('/api/users', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id, username, role, name, created_at FROM users ORDER BY id');
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/users — สร้าง user ใหม่
app.post('/api/users', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { username, password, role = 'staff', name = '' } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'กรุณากรอก username และ password' });
    if (!['admin', 'staff'].includes(role)) return res.status(400).json({ error: 'role ต้องเป็น admin หรือ staff' });

    const hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      'INSERT INTO users (username, password, role, name) VALUES ($1,$2,$3,$4) RETURNING id, username, role, name',
      [username.trim(), hash, role, name.trim()]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'username นี้มีอยู่แล้ว' });
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/users/:id
app.delete('/api/users/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    if (Number(req.params.id) === req.user.id) return res.status(400).json({ error: 'ไม่สามารถลบตัวเองได้' });
    const { rowCount } = await pool.query('DELETE FROM users WHERE id=$1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'ไม่พบ user' });
    res.json({ message: 'ลบสำเร็จ' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/users/:id/password — เปลี่ยน password
app.put('/api/users/:id/password', authMiddleware, async (req, res) => {
  try {
    // admin เปลี่ยนของใครก็ได้ / staff เปลี่ยนของตัวเองเท่านั้น
    if (req.user.role !== 'admin' && Number(req.params.id) !== req.user.id)
      return res.status(403).json({ error: 'ไม่มีสิทธิ์' });

    const { password } = req.body;
    if (!password || password.length < 6) return res.status(400).json({ error: 'password ต้องมีอย่างน้อย 6 ตัวอักษร' });

    const hash = await bcrypt.hash(password, 10);
    await pool.query('UPDATE users SET password=$1 WHERE id=$2', [hash, req.params.id]);
    res.json({ message: 'เปลี่ยน password สำเร็จ' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ════════════════════════════════════════
   SUMMARY
════════════════════════════════════════ */
app.get('/api/summary', authMiddleware, async (req, res) => {
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
      total_in: parseInt(ti.rows[0].t),
      total_out: parseInt(to.rows[0].t),
      low_stock: parseInt(ls.rows[0].count),
      out_of_stock: parseInt(os.rows[0].count),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ════════════════════════════════════════
   PRODUCTS
════════════════════════════════════════ */
app.get('/api/products', authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT sku, name, unit, stock, min_stock AS "minStock", image_url AS "imageUrl" FROM products ORDER BY name'
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/products', authMiddleware, adminOnly, upload.single('image'), async (req, res) => {
  try {
    const { sku, name, unit = 'ชิ้น', stock = 0, minStock = 5 } = req.body;
    if (!sku || !name) return res.status(400).json({ error: 'sku และ name จำเป็นต้องมี' });

    let imageUrl = '';
    if (req.file) imageUrl = await uploadToCloudinary(req.file.buffer, sku.trim());

    const { rows } = await pool.query(
      'INSERT INTO products (sku,name,unit,stock,min_stock,image_url) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [sku.trim(), name.trim(), unit.trim(), Number(stock), Number(minStock), imageUrl]
    );
    res.status(201).json({ ...rows[0], minStock: rows[0].min_stock, imageUrl: rows[0].image_url });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'รหัสสินค้านี้มีอยู่แล้ว' });
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/products/:sku/image', authMiddleware, adminOnly, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'ไม่พบไฟล์รูปภาพ' });
    const imageUrl = await uploadToCloudinary(req.file.buffer, req.params.sku);
    await pool.query('UPDATE products SET image_url=$1 WHERE sku=$2', [imageUrl, req.params.sku]);
    res.json({ message: 'อัปเดตรูปภาพสำเร็จ', imageUrl });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/products/:sku/image', authMiddleware, adminOnly, async (req, res) => {
  try {
    await deleteFromCloudinary(req.params.sku);
    await pool.query('UPDATE products SET image_url=$1 WHERE sku=$2', ['', req.params.sku]);
    res.json({ message: 'ลบรูปภาพสำเร็จ' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/products/:sku', authMiddleware, adminOnly, async (req, res) => {
  try {
    await deleteFromCloudinary(req.params.sku);
    const { rowCount } = await pool.query('DELETE FROM products WHERE sku=$1', [req.params.sku]);
    if (!rowCount) return res.status(404).json({ error: 'ไม่พบสินค้า' });
    res.json({ message: 'ลบสำเร็จ' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ════════════════════════════════════════
   TRANSACTIONS
════════════════════════════════════════ */
app.get('/api/transactions', authMiddleware, async (req, res) => {
  try {
    const { search = '', type = '' } = req.query;
    const conditions = ['1=1'];
    const params = [];
    if (type) { params.push(type); conditions.push(`t.type=$${params.length}`); }
    if (search) {
      params.push(`%${search}%`);
      conditions.push(`(p.name ILIKE $${params.length} OR t.sku ILIKE $${params.length} OR t.note ILIKE $${params.length})`);
    }
    const { rows } = await pool.query(
      `SELECT t.id, t.type, t.sku, p.name, t.qty, t.balance, t.person, t.note,
              t.created_at AS date, p.unit, p.image_url AS "imageUrl"
       FROM transactions t JOIN products p ON t.sku=p.sku
       WHERE ${conditions.join(' AND ')}
       ORDER BY t.created_at DESC LIMIT 200`,
      params
    );
    res.json({ data: rows, total: rows.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/transactions', authMiddleware, async (req, res) => {
  const client = await pool.connect();
  try {
    const { type, sku, qty, person = '', note = '' } = req.body;
    if (!type || !sku || !qty) return res.status(400).json({ error: 'type, sku, qty จำเป็นต้องมี' });
    if (!['in', 'out'].includes(type)) return res.status(400).json({ error: 'type ต้องเป็น in หรือ out' });
    if (Number(qty) <= 0) return res.status(400).json({ error: 'qty ต้องมากกว่า 0' });

    await client.query('BEGIN');
    const { rows: pr } = await client.query('SELECT * FROM products WHERE sku=$1 FOR UPDATE', [sku]);
    if (!pr.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'ไม่พบสินค้า' }); }

    const prod = pr[0];
    const numQty = Number(qty);
    if (type === 'out' && prod.stock < numQty) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `สต็อกไม่เพียงพอ (มี ${prod.stock} ${prod.unit})` });
    }

    const newStock = type === 'in' ? prod.stock + numQty : prod.stock - numQty;
    await client.query('UPDATE products SET stock=$1 WHERE sku=$2', [newStock, sku]);
    const { rows: tr } = await client.query(
      'INSERT INTO transactions (type,sku,qty,balance,person,note) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [type, sku, numQty, newStock, person || req.user.name || req.user.username, note]
    );
    await client.query('COMMIT');

    res.status(201).json({
      transaction: { ...tr[0], name: prod.name, unit: prod.unit, imageUrl: prod.image_url, date: tr[0].created_at },
      new_stock: newStock,
    });
  } catch (e) { await client.query('ROLLBACK'); res.status(500).json({ error: e.message }); }
  finally { client.release(); }
});

// ลบ transaction — admin only
app.delete('/api/transactions/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM transactions WHERE id=$1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'ไม่พบรายการ' });
    res.json({ message: 'ลบสำเร็จ' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ════════════════════════════════════════
   BULK IMPORT — นำเข้าสินค้าจาก JSON
════════════════════════════════════════ */
app.post('/api/import/products', authMiddleware, adminOnly, async (req, res) => {
  const { products } = req.body;
  if (!Array.isArray(products) || !products.length)
    return res.status(400).json({ error: 'ต้องส่ง products เป็น array' });

  try {
    await pool.query(`
      ALTER TABLE products
        ADD COLUMN IF NOT EXISTS cost_price NUMERIC(12,2) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS sale_price NUMERIC(12,2) NOT NULL DEFAULT 0;
    `);
  } catch (e) { /* มีแล้ว */ }

  const BATCH = 500;
  let inserted = 0, failed = 0;

  for (let i = 0; i < products.length; i += BATCH) {
    const batch = products.slice(i, i + BATCH);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const p of batch) {
        await client.query(`
          INSERT INTO products (sku, name, unit, stock, min_stock, cost_price, sale_price, image_url)
          VALUES ($1,$2,$3,$4,$5,$6,$7,'')
          ON CONFLICT (sku) DO UPDATE SET
            name=EXCLUDED.name, unit=EXCLUDED.unit,
            cost_price=EXCLUDED.cost_price, sale_price=EXCLUDED.sale_price
        `, [p.sku, p.name, p.unit, p.stock ?? 0, p.min_stock ?? 5, p.cost_price ?? 0, p.sale_price ?? 0]);
        inserted++;
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      failed += batch.length;
    } finally { client.release(); }
  }

  const { rows } = await pool.query('SELECT COUNT(*) FROM products');
  res.json({ ok: true, inserted, failed, total_in_db: parseInt(rows[0].count) });
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
    console.log(`   Auth:      JWT`);
    console.log(`   Cloudinary: ${process.env.CLOUDINARY_CLOUD_NAME || 'ไม่ได้ตั้งค่า'}`);
    console.log('');
  });
}).catch(err => {
  console.error('❌ Database init failed:', err.message);
  process.exit(1);
});
