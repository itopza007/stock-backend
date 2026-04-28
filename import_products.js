/**
 * import_products.js
 * นำเข้าสินค้าจากไฟล์ products_data.json เข้า PostgreSQL
 * 
 * วิธีใช้:
 *   1. วางไฟล์นี้ใน D:\งานเว็ป1\stock-backend\
 *   2. วางไฟล์ products_data.json ใน D:\งานเว็ป1\stock-backend\
 *   3. เปิด Terminal ใน stock-backend แล้วรัน:
 *      node import_products.js
 */

require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function importProducts() {
  console.log('🚀 เริ่มนำเข้าข้อมูลสินค้า...\n');

  // โหลดข้อมูล
  const dataPath = path.join(__dirname, 'products_data.json');
  if (!fs.existsSync(dataPath)) {
    console.error('❌ ไม่พบไฟล์ products_data.json');
    process.exit(1);
  }
  const products = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
  console.log(`📦 พบสินค้าทั้งหมด: ${products.length} รายการ`);

  // เพิ่มคอลัมน์ cost_price และ sale_price ถ้ายังไม่มี
  try {
    await pool.query(`
      ALTER TABLE products 
        ADD COLUMN IF NOT EXISTS cost_price NUMERIC(12,2) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS sale_price NUMERIC(12,2) NOT NULL DEFAULT 0;
    `);
    console.log('✅ เพิ่มคอลัมน์ cost_price, sale_price เรียบร้อย');
  } catch (e) {
    console.log('ℹ️  คอลัมน์ราคามีอยู่แล้ว');
  }

  // นำเข้าทีละ batch 500 รายการ
  const BATCH = 500;
  let inserted = 0;
  let skipped = 0;

  for (let i = 0; i < products.length; i += BATCH) {
    const batch = products.slice(i, i + BATCH);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const p of batch) {
        await client.query(`
          INSERT INTO products (sku, name, unit, stock, min_stock, cost_price, sale_price, image_url)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          ON CONFLICT (sku) DO UPDATE SET
            name       = EXCLUDED.name,
            unit       = EXCLUDED.unit,
            cost_price = EXCLUDED.cost_price,
            sale_price = EXCLUDED.sale_price
        `, [p.sku, p.name, p.unit, p.stock, p.min_stock, p.cost_price, p.sale_price, p.image_url]);
        inserted++;
      }
      await client.query('COMMIT');
      const pct = Math.round((inserted / products.length) * 100);
      process.stdout.write(`\r⏳ นำเข้าแล้ว ${inserted}/${products.length} รายการ (${pct}%)`);
    } catch (e) {
      await client.query('ROLLBACK');
      console.error(`\n❌ Error at batch ${i}: ${e.message}`);
      skipped += batch.length;
    } finally {
      client.release();
    }
  }

  console.log(`\n\n✅ นำเข้าสำเร็จ: ${inserted - skipped} รายการ`);
  if (skipped > 0) console.log(`⚠️  ข้ามไป: ${skipped} รายการ`);

  // ตรวจสอบผล
  const { rows } = await pool.query('SELECT COUNT(*) FROM products');
  console.log(`📊 สินค้าในฐานข้อมูลทั้งหมด: ${rows[0].count} รายการ`);

  await pool.end();
  console.log('\n🎉 เสร็จสิ้น!');
}

importProducts().catch(err => {
  console.error('❌ เกิดข้อผิดพลาด:', err.message);
  process.exit(1);
});
