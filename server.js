const express  = require('express');
const cors     = require('cors');
const XLSX     = require('xlsx');
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');
const cloudinary = require('cloudinary').v2;

const app  = express();
const PORT = process.env.PORT || 4000;

// Cloudinary config จาก environment variables
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const DATA_DIR  = path.join(__dirname, 'data');
const XLSX_FILE = path.join(DATA_DIR, 'stock.xlsx');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

app.use(cors());
app.use(express.json());

// Multer — เก็บใน memory แล้วส่งต่อ Cloudinary (ไม่เก็บในเครื่อง)
const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error('รองรับเฉพาะไฟล์ภาพ (.jpg .png .webp .gif)'));
  },
  limits: { fileSize: 5 * 1024 * 1024 },
});

// อัปโหลดรูปขึ้น Cloudinary
async function uploadToCloudinary(buffer, sku) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { public_id: `stock/${sku}`, overwrite: true, resource_type: 'image' },
      (err, result) => err ? reject(err) : resolve(result.secure_url)
    );
    stream.end(buffer);
  });
}

// ลบรูปจาก Cloudinary
async function deleteFromCloudinary(sku) {
  try { await cloudinary.uploader.destroy(`stock/${sku}`); } catch {}
}

/* ════════════════════════════════════════
   Excel helpers
════════════════════════════════════════ */
function readExcel() {
  if (!fs.existsSync(XLSX_FILE)) {
    const wb = XLSX.utils.book_new();
    const products = [
      { sku:'P001', name:'กระดาษ A4',    unit:'รีม',   stock:50, minStock:10, imageUrl:'' },
      { sku:'P002', name:'ปากกาลูกลื่น', unit:'ด้าม',  stock:4,  minStock:20, imageUrl:'' },
      { sku:'P003', name:'แฟ้มเอกสาร',   unit:'อัน',   stock:0,  minStock:5,  imageUrl:'' },
      { sku:'P004', name:'หมึกพิมพ์',    unit:'กล่อง', stock:15, minStock:3,  imageUrl:'' },
      { sku:'P005', name:'กรรไกร',       unit:'อัน',   stock:8,  minStock:2,  imageUrl:'' },
    ];
    const transactions = [
      { id:1, type:'in',  sku:'P001', name:'กระดาษ A4',    qty:20, balance:50, person:'สมชาย',  note:'รับจาก Supplier A', date: new Date(Date.now()-86400000*2).toISOString() },
      { id:2, type:'out', sku:'P002', name:'ปากกาลูกลื่น', qty:16, balance:4,  person:'สมหญิง', note:'จ่ายแผนก HR',       date: new Date(Date.now()-86400000).toISOString()   },
      { id:3, type:'in',  sku:'P004', name:'หมึกพิมพ์',    qty:5,  balance:15, person:'สมชาย',  note:'รับเพิ่ม',          date: new Date(Date.now()-3600000*3).toISOString()  },
    ];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(products),     'products');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(transactions), 'transactions');
    XLSX.writeFile(wb, XLSX_FILE);
  }
  const wb = XLSX.readFile(XLSX_FILE);
  return {
    products:     XLSX.utils.sheet_to_json(wb.Sheets['products']     || {}),
    transactions: XLSX.utils.sheet_to_json(wb.Sheets['transactions'] || {}),
  };
}

function writeExcel(products, transactions) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(products),     'products');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(transactions), 'transactions');
  XLSX.writeFile(wb, XLSX_FILE);
}

/* ════════════════════════════════════════
   Health check
════════════════════════════════════════ */
app.get('/health', (req, res) => {
  res.json({ status:'ok', cloudinary: !!process.env.CLOUDINARY_CLOUD_NAME, time: new Date() });
});

/* ════════════════════════════════════════
   SUMMARY
════════════════════════════════════════ */
app.get('/api/summary', (req, res) => {
  try {
    const { products, transactions } = readExcel();
    res.json({
      total_products: products.length,
      total_in:       transactions.filter(t=>t.type==='in').reduce((a,t)=>a+Number(t.qty),0),
      total_out:      transactions.filter(t=>t.type==='out').reduce((a,t)=>a+Number(t.qty),0),
      low_stock:      products.filter(p=>Number(p.stock)>0&&Number(p.stock)<=Number(p.minStock)).length,
      out_of_stock:   products.filter(p=>Number(p.stock)===0).length,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

/* ════════════════════════════════════════
   PRODUCTS
════════════════════════════════════════ */
app.get('/api/products', (req, res) => {
  try {
    const { products } = readExcel();
    res.json(products);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/products — เพิ่มสินค้า + รูปภาพ
app.post('/api/products', upload.single('image'), async (req, res) => {
  try {
    const { sku, name, unit='ชิ้น', stock=0, minStock=5 } = req.body;
    if (!sku || !name) return res.status(400).json({ error: 'sku และ name จำเป็นต้องมี' });

    const { products, transactions } = readExcel();
    if (products.find(p => p.sku === sku)) return res.status(409).json({ error: 'รหัสสินค้านี้มีอยู่แล้ว' });

    let imageUrl = '';
    if (req.file) {
      imageUrl = await uploadToCloudinary(req.file.buffer, sku.trim());
    }

    const newProduct = {
      sku: sku.trim(), name: name.trim(), unit: unit.trim(),
      stock: Number(stock), minStock: Number(minStock), imageUrl,
    };
    products.push(newProduct);
    writeExcel(products, transactions);
    res.status(201).json(newProduct);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/products/:sku/image — เปลี่ยนรูปภาพ
app.put('/api/products/:sku/image', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'ไม่พบไฟล์รูปภาพ' });
    const { sku } = req.params;
    let { products, transactions } = readExcel();
    const idx = products.findIndex(p => p.sku === sku);
    if (idx === -1) return res.status(404).json({ error: 'ไม่พบสินค้า' });

    const imageUrl = await uploadToCloudinary(req.file.buffer, sku);
    products[idx] = { ...products[idx], imageUrl };
    writeExcel(products, transactions);
    res.json({ message: 'อัปเดตรูปภาพสำเร็จ', imageUrl });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/products/:sku/image — ลบรูปภาพ
app.delete('/api/products/:sku/image', async (req, res) => {
  try {
    const { sku } = req.params;
    let { products, transactions } = readExcel();
    const idx = products.findIndex(p => p.sku === sku);
    if (idx === -1) return res.status(404).json({ error: 'ไม่พบสินค้า' });

    await deleteFromCloudinary(sku);
    products[idx] = { ...products[idx], imageUrl: '' };
    writeExcel(products, transactions);
    res.json({ message: 'ลบรูปภาพสำเร็จ' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/products/:sku
app.delete('/api/products/:sku', async (req, res) => {
  try {
    let { products, transactions } = readExcel();
    if (!products.find(p => p.sku === req.params.sku)) return res.status(404).json({ error: 'ไม่พบสินค้า' });

    await deleteFromCloudinary(req.params.sku);
    products     = products.filter(p => p.sku !== req.params.sku);
    transactions = transactions.filter(t => t.sku !== req.params.sku);
    writeExcel(products, transactions);
    res.json({ message: 'ลบสำเร็จ' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

/* ════════════════════════════════════════
   TRANSACTIONS
════════════════════════════════════════ */
app.get('/api/transactions', (req, res) => {
  try {
    const { transactions, products } = readExcel();
    const { search='', type='' } = req.query;
    const prodMap = Object.fromEntries(products.map(p => [p.sku, p]));

    let list = [...transactions].reverse();
    if (type)   list = list.filter(t => t.type === type);
    if (search) list = list.filter(t =>
      String(t.name||'').toLowerCase().includes(search.toLowerCase()) ||
      String(t.sku||'').toLowerCase().includes(search.toLowerCase())  ||
      String(t.note||'').toLowerCase().includes(search.toLowerCase())
    );

    list = list.map(t => ({
      ...t,
      unit:     prodMap[t.sku]?.unit || '',
      imageUrl: prodMap[t.sku]?.imageUrl || '',
    }));

    res.json({ data: list, total: list.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/transactions', (req, res) => {
  try {
    const { type, sku, qty, person='', note='' } = req.body;
    if (!type||!sku||!qty) return res.status(400).json({ error: 'type, sku, qty จำเป็นต้องมี' });
    if (!['in','out'].includes(type)) return res.status(400).json({ error: 'type ต้องเป็น in หรือ out' });
    if (Number(qty)<=0) return res.status(400).json({ error: 'qty ต้องมากกว่า 0' });

    let { products, transactions } = readExcel();
    const idx = products.findIndex(p => p.sku === sku);
    if (idx===-1) return res.status(404).json({ error: 'ไม่พบสินค้า' });

    const prod     = products[idx];
    const numQty   = Number(qty);
    const curStock = Number(prod.stock);

    if (type==='out'&&curStock<numQty)
      return res.status(400).json({ error: `สต็อกไม่เพียงพอ (มี ${curStock} ${prod.unit})` });

    const newStock  = type==='in' ? curStock+numQty : curStock-numQty;
    products[idx]   = { ...prod, stock: newStock };

    const maxId  = transactions.length ? Math.max(...transactions.map(t=>Number(t.id)||0)) : 0;
    const newTxn = { id:maxId+1, type, sku:prod.sku, name:prod.name, qty:numQty, balance:newStock, person, note, date:new Date().toISOString() };
    transactions.push(newTxn);
    writeExcel(products, transactions);

    res.status(201).json({
      transaction: { ...newTxn, unit:prod.unit, imageUrl:prod.imageUrl||'' },
      new_stock: newStock,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/transactions/:id', (req, res) => {
  try {
    let { products, transactions } = readExcel();
    if (!transactions.find(t=>Number(t.id)===Number(req.params.id)))
      return res.status(404).json({ error: 'ไม่พบรายการ' });
    transactions = transactions.filter(t=>Number(t.id)!==Number(req.params.id));
    writeExcel(products, transactions);
    res.json({ message: 'ลบสำเร็จ' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

/* ════════════════════════════════════════
   Serve React frontend
════════════════════════════════════════ */
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/* ════════════════════════════════════════
   Start
════════════════════════════════════════ */
app.listen(PORT, () => {
  console.log('');
  console.log('✅ Stock Backend พร้อมใช้งานแล้ว!');
  console.log(`   PORT:      ${PORT}`);
  console.log(`   Cloudinary: ${process.env.CLOUDINARY_CLOUD_NAME || 'ไม่ได้ตั้งค่า'}`);
  console.log('');
});
