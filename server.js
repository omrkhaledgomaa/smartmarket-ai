'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT || 3000);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || '';
function verifyAdminPassword(candidate){
 if(ADMIN_PASSWORD_HASH){const parts=ADMIN_PASSWORD_HASH.split('$');if(parts.length!==3||parts[0]!=='scrypt')return false;try{const salt=Buffer.from(parts[1],'base64'),expected=Buffer.from(parts[2],'base64'),actual=crypto.scryptSync(String(candidate||''),salt,expected.length);return expected.length===actual.length&&crypto.timingSafeEqual(actual,expected);}catch{return false;}}
 const provided=Buffer.from(String(candidate||'')),expected=Buffer.from(ADMIN_PASSWORD);return provided.length===expected.length&&crypto.timingSafeEqual(provided,expected);
}
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true' || process.env.NODE_ENV === 'production';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'smartmarket.sqlite');
const PUBLIC_FILE = path.join(__dirname, 'public.html');
const ADMIN_FILE = path.join(__dirname, 'admin.html');
if (!ADMIN_PASSWORD_HASH && ADMIN_PASSWORD.length < 12) {
  console.error('Set ADMIN_PASSWORD or ADMIN_PASSWORD_HASH to a unique admin credential.');
  process.exit(1);
}
if (Number(process.versions.node.split('.')[0]) < 22) {
  console.error('Node.js 22+ is required for the built-in SQLite module.');
  process.exit(1);
}
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
db.exec(`
CREATE TABLE IF NOT EXISTS products (
 id INTEGER PRIMARY KEY, name TEXT NOT NULL, cat TEXT NOT NULL DEFAULT 'أخرى', emoji TEXT NOT NULL DEFAULT '🛍️',
 price INTEGER NOT NULL CHECK(price>0), description TEXT NOT NULL DEFAULT '', stock INTEGER NOT NULL CHECK(stock>=0)
);
CREATE TABLE IF NOT EXISTS orders (
 order_no TEXT PRIMARY KEY, date TEXT NOT NULL, name TEXT NOT NULL, phone TEXT NOT NULL, address TEXT NOT NULL,
 items_json TEXT NOT NULL, subtotal INTEGER NOT NULL, discount INTEGER NOT NULL, coupon TEXT NOT NULL DEFAULT '',
 shipping INTEGER NOT NULL, total INTEGER NOT NULL, status TEXT NOT NULL,
 courier_name TEXT NOT NULL DEFAULT '', courier_phone TEXT NOT NULL DEFAULT '', tracking_code TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS coupons (code TEXT PRIMARY KEY, type TEXT NOT NULL, value INTEGER NOT NULL, minimum INTEGER NOT NULL DEFAULT 0, expires_on TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS suppliers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, phone TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS purchases (id INTEGER PRIMARY KEY, supplier_id INTEGER NOT NULL, purchase_date TEXT NOT NULL, reference TEXT NOT NULL DEFAULT '', total INTEGER NOT NULL CHECK(total>=0), notes TEXT NOT NULL DEFAULT '', FOREIGN KEY(supplier_id) REFERENCES suppliers(id));
CREATE TABLE IF NOT EXISTS purchase_items (id INTEGER PRIMARY KEY, purchase_id INTEGER NOT NULL, product_id INTEGER NOT NULL, quantity INTEGER NOT NULL CHECK(quantity>0), unit_cost INTEGER NOT NULL CHECK(unit_cost>0), line_total INTEGER NOT NULL, FOREIGN KEY(purchase_id) REFERENCES purchases(id) ON DELETE CASCADE, FOREIGN KEY(product_id) REFERENCES products(id));
CREATE TABLE IF NOT EXISTS admin_sessions (token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS order_status_history (id INTEGER PRIMARY KEY AUTOINCREMENT, order_no TEXT NOT NULL, status TEXT NOT NULL, changed_at TEXT NOT NULL, FOREIGN KEY(order_no) REFERENCES orders(order_no) ON DELETE CASCADE);
CREATE INDEX IF NOT EXISTS order_status_history_order_idx ON order_status_history(order_no,id);
CREATE INDEX IF NOT EXISTS admin_sessions_expiry_idx ON admin_sessions(expires_at);
`);
// Add delivery metadata columns to existing databases without replacing data.
const productColumns=new Set(db.prepare('PRAGMA table_info(products)').all().map(c=>c.name));
if(!productColumns.has('cost_price')) db.exec('ALTER TABLE products ADD COLUMN cost_price INTEGER NOT NULL DEFAULT 0 CHECK(cost_price>=0)');
const couponColumns=new Set(db.prepare('PRAGMA table_info(coupons)').all().map(c=>c.name));
for(const [column,definition] of [['expires_on',"TEXT NOT NULL DEFAULT ''"],['enabled','INTEGER NOT NULL DEFAULT 1']]) if(!couponColumns.has(column)) db.exec(`ALTER TABLE coupons ADD COLUMN ${column} ${definition}`);
const orderColumns=new Set(db.prepare('PRAGMA table_info(orders)').all().map(c=>c.name));
for(const [column,definition] of [['courier_name',"TEXT NOT NULL DEFAULT ''"],['courier_phone',"TEXT NOT NULL DEFAULT ''"],['tracking_code',"TEXT NOT NULL DEFAULT ''"]]) if(!orderColumns.has(column)) db.exec(`ALTER TABLE orders ADD COLUMN ${column} ${definition}`);
const defaultProducts = [
 {id:1,name:'سماعة لاسلكية',cat:'إلكترونيات',emoji:'🎧',price:850,desc:'صوت واضح وبطارية تدوم طويلاً',stock:10},
 {id:2,name:'ساعة ذكية',cat:'إلكترونيات',emoji:'⌚',price:1250,desc:'متابعة النشاط وإشعارات الهاتف',stock:10},
 {id:3,name:'طقم أدوات منزلي',cat:'المنزل',emoji:'🧰',price:650,desc:'مجموعة عملية للأعمال المنزلية البسيطة',stock:10},
 {id:4,name:'مصباح LED',cat:'المنزل',emoji:'💡',price:220,desc:'إضاءة اقتصادية مناسبة للمنزل',stock:10}
];
if (db.prepare('SELECT COUNT(*) AS n FROM products').get().n === 0) {
  const insert = db.prepare('INSERT INTO products(id,name,cat,emoji,price,description,stock) VALUES(?,?,?,?,?,?,?)');
  for (const p of defaultProducts) insert.run(p.id,p.name,p.cat,p.emoji,p.price,p.desc,p.stock);
}
if (!db.prepare('SELECT value FROM settings WHERE key=?').get('shippingFee')) db.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run('shippingFee','0');
for (const c of [{code:'SMART10',type:'percent',value:10,minimum:0},{code:'SAVE50',type:'fixed',value:50,minimum:500}]) {
 if (!db.prepare('SELECT code FROM coupons WHERE code=?').get(c.code)) db.prepare('INSERT INTO coupons(code,type,value,minimum) VALUES(?,?,?,?)').run(c.code,c.type,c.value,c.minimum);
}
// Import legacy JSON data once, if present and the new database is still empty.
const legacyPath = path.join(DATA_DIR,'store.json');
if (fs.existsSync(legacyPath) && db.prepare('SELECT COUNT(*) AS n FROM orders').get().n === 0) {
 try {
  const legacy=JSON.parse(fs.readFileSync(legacyPath,'utf8'));
  if (Array.isArray(legacy.products)) {
   db.exec('BEGIN');
   db.prepare('DELETE FROM products').run();
   const ins=db.prepare('INSERT INTO products(id,name,cat,emoji,price,description,stock) VALUES(?,?,?,?,?,?,?)');
   for(const p of legacy.products) ins.run(Number(p.id),String(p.name||'منتج'),String(p.cat||'أخرى'),String(p.emoji||'🛍️'),Math.max(1,Number(p.price)||1),String(p.desc||''),Math.max(0,Number(p.stock)||0));
   if(Array.isArray(legacy.orders)) { const oi=db.prepare('INSERT OR IGNORE INTO orders(order_no,date,name,phone,address,items_json,subtotal,discount,coupon,shipping,total,status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)');
    for(const o of legacy.orders) oi.run(String(o.orderNo||''),String(o.date||new Date().toISOString()),String(o.name||''),String(o.phone||''),String(o.address||o.addr||''),JSON.stringify(o.items||[]),Number(o.subtotal||o.total||0),Number(o.discount||0),String(o.coupon||''),Number(o.shipping||0),Number(o.total||0),String(o.status||'جديد'));
   }
   if(legacy.settings&&Number.isFinite(Number(legacy.settings.shippingFee)))db.prepare('UPDATE settings SET value=? WHERE key=?').run(String(Math.max(0,Number(legacy.settings.shippingFee))),'shippingFee');
   db.exec('COMMIT'); console.log('Imported legacy store.json into SQLite.');
  }
 } catch(e){try{db.exec('ROLLBACK')}catch{} console.warn('Legacy import skipped:',e.message)}
}
function products(){return db.prepare('SELECT id,name,cat,emoji,price,description AS desc,stock FROM products ORDER BY id').all();}
function getSettings(){return {shippingFee:Math.max(0,Number(db.prepare('SELECT value FROM settings WHERE key=?').get('shippingFee')?.value)||0)};}
function orderObj(row){return {orderNo:row.order_no,date:row.date,name:row.name,phone:row.phone,address:row.address,items:JSON.parse(row.items_json),subtotal:row.subtotal,discount:row.discount,coupon:row.coupon,shipping:row.shipping,total:row.total,status:row.status,courierName:row.courier_name||'',courierPhone:row.courier_phone||'',trackingCode:row.tracking_code||''};}
function orderHistory(orderNo){return db.prepare('SELECT status,changed_at AS changedAt FROM order_status_history WHERE order_no=? ORDER BY id').all(orderNo);}
// Backfill one known status for legacy orders imported before history tracking.
for(const row of db.prepare('SELECT order_no,status,date FROM orders WHERE NOT EXISTS (SELECT 1 FROM order_status_history h WHERE h.order_no=orders.order_no)').all()) db.prepare('INSERT INTO order_status_history(order_no,status,changed_at) VALUES(?,?,?)').run(row.order_no,row.status,row.date);
function allOrders(){return db.prepare('SELECT * FROM orders ORDER BY date DESC').all().map(row=>({...orderObj(row),history:orderHistory(row.order_no)}));}
function saveShipping(fee){db.prepare('UPDATE settings SET value=? WHERE key=?').run(String(fee),'shippingFee');}
function couponRows(){return db.prepare('SELECT code,type,value,minimum,expires_on AS expiresOn,enabled FROM coupons ORDER BY code').all().map(c=>({...c,enabled:!!c.enabled}));}
function validateCoupon(b){const code=cleanText(b.code,30).toUpperCase(),type=b.type,value=Number(b.value),minimum=Number(b.minimum??0),expiresOn=cleanText(b.expiresOn,10);if(!/^[A-Z0-9_-]{3,30}$/.test(code)||!['percent','fixed'].includes(type)||!Number.isInteger(value)||value<=0||(type==='percent'&&value>100)||!Number.isInteger(minimum)||minimum<0||minimum>100000000|| (expiresOn&&!/^\d{4}-\d{2}-\d{2}$/.test(expiresOn)))return null;if(expiresOn){const d=new Date(expiresOn+'T00:00:00Z');if(Number.isNaN(d.getTime())||d.toISOString().slice(0,10)!==expiresOn)return null;}return {code,type,value,minimum,expiresOn,enabled:b.enabled===undefined?true:!!b.enabled};}
function couponIsValid(c,subtotal){return !!c&&!!c.enabled&&subtotal>=c.minimum&&(!c.expires_on||c.expires_on>=new Date().toISOString().slice(0,10));}
function json(res,status,data){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data));}
function parseCookies(req){return Object.fromEntries((req.headers.cookie||'').split(';').map(x=>x.trim()).filter(Boolean).map(x=>{const i=x.indexOf('=');return [decodeURIComponent(x.slice(0,i)),decodeURIComponent(x.slice(i+1))]}));}
const loginAttempts=new Map(),trackLimits=new Map();
function tokenHash(token){return crypto.createHash('sha256').update(String(token)).digest('hex');}
function sessionFor(req){const token=parseCookies(req).sm_session;if(!token)return null;const row=db.prepare('SELECT expires_at FROM admin_sessions WHERE token_hash=?').get(tokenHash(token));if(row&&row.expires_at>Date.now())return {exp:row.expires_at};if(row)db.prepare('DELETE FROM admin_sessions WHERE token_hash=?').run(tokenHash(token));return null;}
function requireAdmin(req,res){if(!sessionFor(req)){json(res,401,{error:'admin_login_required'});return false;}return true;}
function readBody(req,limit=100000){return new Promise((resolve,reject)=>{let chunks=[],size=0;req.on('data',c=>{size+=c.length;if(size>limit){reject(new Error('body_too_large'));req.destroy();}else chunks.push(c)});req.on('end',()=>{try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}'))}catch{reject(new Error('invalid_json'))}});req.on('error',reject);});}
function cleanText(v,max=200){return String(v??'').trim().slice(0,max);}
function validStatus(s){return ['جديد','قيد التجهيز','تم الشحن','تم التسليم','ملغي'].includes(s);}
function newOrderNo(){return 'SM-'+crypto.randomBytes(8).toString('hex').toUpperCase();}
function normalizePhone(v){return String(v||'').replace(/[\s()-]/g,'');}
function checkOrigin(req){const origin=req.headers.origin;if(!origin)return false;try{return new URL(origin).host===req.headers.host;}catch{return false;}}
function csrfCheck(req,res){if(!checkOrigin(req)){json(res,403,{error:'origin_check_failed'});return false;}if(!String(req.headers['content-type']||'').toLowerCase().includes('application/json')){json(res,415,{error:'json_required'});return false;}return true;}
function rateLimit(map,key,max,windowMs){const now=Date.now(),rec=map.get(key)||{count:0,start:now};if(now-rec.start>windowMs){rec.count=0;rec.start=now;}rec.count++;map.set(key,rec);return rec.count<=max;}
const server=http.createServer(async(req,res)=>{
 res.setHeader('X-Frame-Options','DENY');res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');res.setHeader('X-Content-Type-Options','nosniff');
 res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
 res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
 const url=new URL(req.url,'http://localhost'),p=url.pathname,ip=req.socket.remoteAddress||'unknown';
 if(req.method==='GET'&&p==='/'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});res.end(fs.readFileSync(PUBLIC_FILE));return;}
 if(req.method==='GET'&&p==='/health'){json(res,200,{ok:true,service:'SmartMarket backend',database:'sqlite'});return;}
 if(req.method==='GET'&&p==='/api/products'){json(res,200,{products:products()});return;}
 if(req.method==='GET'&&p==='/api/public/settings'){json(res,200,{settings:getSettings()});return;}
 if(req.method==='GET'&&p.startsWith('/api/orders/')){
  if(!rateLimit(trackLimits,ip,25,60*1000)){json(res,429,{error:'tracking_rate_limit'});return;}
  const no=decodeURIComponent(p.slice('/api/orders/'.length)),phone=normalizePhone(url.searchParams.get('phone'));
  const row=db.prepare('SELECT * FROM orders WHERE order_no=? AND phone=?').get(no,phone);
  if(!row){json(res,404,{error:'order_not_found'});return;}const o=orderObj(row);
  json(res,200,{order:{orderNo:o.orderNo,date:o.date,status:o.status,items:o.items,subtotal:o.subtotal,discount:o.discount,shipping:o.shipping,total:o.total}});return;
 }
 if(req.method==='GET'&&p==='/admin'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});res.end(fs.readFileSync(ADMIN_FILE));return;}
 if(req.method==='POST'&&p==='/api/orders'){
  if(!csrfCheck(req,res))return;
  try{
   const b=await readBody(req),name=cleanText(b.name,100),phone=normalizePhone(b.phone),address=cleanText(b.address,500);
   if(!name||!address||!/^(?:01[0125]\d{8}|(?:\+?20)?1[0125]\d{8})$/.test(phone)){json(res,400,{error:'invalid_customer_data'});return;}
   if(!Array.isArray(b.items)||!b.items.length||b.items.length>50){json(res,400,{error:'invalid_items'});return;}
   const merged=new Map();for(const it of b.items){const id=Number(it.id),qty=Number(it.qty);if(!Number.isInteger(id)||!Number.isInteger(qty)||qty<1||qty>100){json(res,400,{error:'invalid_product_or_quantity'});return;}merged.set(id,(merged.get(id)||0)+qty);}
   db.exec('BEGIN IMMEDIATE');try{
    let subtotal=0,normalized=[];
    for(const [id,qty] of merged){if(qty>100){throw Object.assign(new Error('quantity_limit_exceeded'),{status:400});}const product=db.prepare('SELECT * FROM products WHERE id=?').get(id);if(!product)throw Object.assign(new Error('invalid_product_or_quantity'),{status:400});if(product.stock<qty)throw Object.assign(new Error('stock_unavailable'),{status:409,product:product.name,available:product.stock});subtotal+=product.price*qty;normalized.push({id:product.id,product:product.name,qty,price:product.price});}
    let discount=0,coupon='';const code=cleanText(b.coupon,30).toUpperCase(),c=db.prepare('SELECT * FROM coupons WHERE code=?').get(code);if(couponIsValid(c,subtotal)){if(c.type==='percent')discount=Math.round(subtotal*c.value/100);else discount=Math.min(c.value,subtotal);if(discount>0)coupon=code;}
    const shipping=getSettings().shippingFee,total=subtotal-discount+shipping;
    for(const it of normalized){const r=db.prepare('UPDATE products SET stock=stock-? WHERE id=? AND stock>=?').run(it.qty,it.id,it.qty);if(r.changes!==1)throw Object.assign(new Error('stock_unavailable'),{status:409});}
    const order={orderNo:newOrderNo(),date:new Date().toISOString(),name,phone,address,items:normalized,subtotal,discount,coupon,shipping,total,status:'جديد'};
    db.prepare('INSERT INTO orders(order_no,date,name,phone,address,items_json,subtotal,discount,coupon,shipping,total,status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(order.orderNo,order.date,name,phone,address,JSON.stringify(normalized),subtotal,discount,coupon,shipping,total,order.status);
    db.prepare('INSERT INTO order_status_history(order_no,status,changed_at) VALUES(?,?,?)').run(order.orderNo,order.status,order.date);
    db.exec('COMMIT');json(res,201,{orderNo:order.orderNo,total,status:order.status});
   }catch(e){db.exec('ROLLBACK');json(res,e.status||400,{error:e.message||'bad_request',...(e.product?{product:e.product,available:e.available}:{})});}
  }catch(e){json(res,e.message==='body_too_large'?413:400,{error:e.message||'bad_request'});}return;
 }
 if(req.method==='POST'&&p==='/api/admin/login'){
  if(!csrfCheck(req,res))return;const rec=loginAttempts.get(ip)||{count:0,until:0},now=Date.now();if(rec.until>now){json(res,429,{error:'try_later'});return;}
  try{const b=await readBody(req,5000),valid=verifyAdminPassword(b.password);
   if(!valid){rec.count++;if(rec.count>=6){rec.until=now+10*60*1000;rec.count=0;}loginAttempts.set(ip,rec);json(res,401,{error:'invalid_credentials'});return;}
   loginAttempts.delete(ip);const id=crypto.randomBytes(32).toString('hex'),exp=now+8*60*60*1000;db.prepare('INSERT INTO admin_sessions(token_hash,expires_at) VALUES(?,?)').run(tokenHash(id),exp);db.prepare('DELETE FROM admin_sessions WHERE expires_at<=?').run(now);res.writeHead(200,{'Content-Type':'application/json','Set-Cookie':`sm_session=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${COOKIE_SECURE?'; Secure':''}`,'Cache-Control':'no-store'});res.end(JSON.stringify({ok:true}));
  }catch{json(res,400,{error:'bad_request'});}return;
 }
 if(req.method==='POST'&&p==='/api/admin/logout'){
  if(!csrfCheck(req,res))return;const c=parseCookies(req);if(c.sm_session)db.prepare('DELETE FROM admin_sessions WHERE token_hash=?').run(tokenHash(c.sm_session));res.writeHead(200,{'Set-Cookie':`sm_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${COOKIE_SECURE?'; Secure':''}`,'Cache-Control':'no-store'});res.end(JSON.stringify({ok:true}));return;
 }
 if(p.startsWith('/api/admin/')){
  if(!requireAdmin(req,res))return;
  if(['POST','PUT','PATCH','DELETE'].includes(req.method)&&!csrfCheck(req,res))return;
  if(req.method==='GET'&&p==='/api/admin/orders'){json(res,200,{orders:allOrders()});return;}
  if(req.method==='GET'&&p==='/api/admin/reports'){
   const period=url.searchParams.get('period')||'30';if(!['7','30','all'].includes(period)){json(res,400,{error:'invalid_report_period'});return;}
   const cutoff=period==='all'?null:new Date(Date.now()-Number(period)*86400000).toISOString();
   const rows=cutoff?db.prepare('SELECT * FROM orders WHERE date>=?').all(cutoff):db.prepare('SELECT * FROM orders').all();
   const active=rows.filter(o=>o.status!=='ملغي'),sales=active.reduce((n,o)=>n+Number(o.total||0),0),discounts=active.reduce((n,o)=>n+Number(o.discount||0),0);
   const statusCounts={};for(const o of rows)statusCounts[o.status]=(statusCounts[o.status]||0)+1;
   const products=new Map();for(const o of active){let items=[];try{items=JSON.parse(o.items_json)}catch{}for(const it of items){const key=String(it.id??it.product??it.name??'unknown'),entry=products.get(key)||{name:cleanText(it.product||it.name||'منتج',120),quantity:0,revenue:0};entry.quantity+=Number(it.qty||0);entry.revenue+=Number(it.qty||0)*Number(it.price||0);products.set(key,entry);}}
   const topProducts=[...products.values()].sort((a,b)=>b.quantity-a.quantity).slice(0,10);json(res,200,{period,ordersCount:active.length,canceledCount:rows.length-active.length,sales,discounts,averageOrder:active.length?Math.round(sales/active.length):0,statusCounts,topProducts});return;
  }
  if(req.method==='GET'&&p==='/api/admin/customers'){
   const customers=db.prepare(`SELECT o.phone, (SELECT name FROM orders x WHERE x.phone=o.phone ORDER BY x.date DESC LIMIT 1) AS name, (SELECT address FROM orders x WHERE x.phone=o.phone ORDER BY x.date DESC LIMIT 1) AS address, COUNT(CASE WHEN o.status<>'ملغي' THEN 1 END) AS ordersCount, COALESCE(SUM(CASE WHEN o.status<>'ملغي' THEN o.total ELSE 0 END),0) AS totalSpent, COUNT(CASE WHEN o.status='ملغي' THEN 1 END) AS canceledCount, MAX(o.date) AS lastOrderDate, (SELECT order_no FROM orders x WHERE x.phone=o.phone ORDER BY x.date DESC LIMIT 1) AS lastOrderNo FROM orders o GROUP BY o.phone ORDER BY lastOrderDate DESC`).all();
   json(res,200,{customers});return;
  }
  if(req.method==='GET'&&p==='/api/admin/suppliers'){json(res,200,{suppliers:db.prepare('SELECT id,name,phone,notes,created_at AS createdAt FROM suppliers ORDER BY name').all()});return;}
  if(req.method==='POST'&&p==='/api/admin/suppliers'){try{const b=await readBody(req),name=cleanText(b.name,120),phone=cleanText(b.phone,40),notes=cleanText(b.notes,500);if(!name||String(b.name||'').length>120||String(b.phone||'').length>40||String(b.notes||'').length>500){json(res,400,{error:'invalid_supplier'});return;}const r=db.prepare('INSERT INTO suppliers(name,phone,notes,created_at) VALUES(?,?,?,?)').run(name,phone,notes,new Date().toISOString());json(res,201,{supplier:{id:Number(r.lastInsertRowid),name,phone,notes}});}catch{json(res,400,{error:'bad_request'});}return;}
  const supplierMatch=p.match(/^\/api\/admin\/suppliers\/(\d+)$/);if(supplierMatch){const id=Number(supplierMatch[1]);if(req.method==='PUT'){try{const b=await readBody(req),name=cleanText(b.name,120),phone=cleanText(b.phone,40),notes=cleanText(b.notes,500);if(!name||String(b.name||'').length>120||String(b.phone||'').length>40||String(b.notes||'').length>500){json(res,400,{error:'invalid_supplier'});return;}const r=db.prepare('UPDATE suppliers SET name=?,phone=?,notes=? WHERE id=?').run(name,phone,notes,id);if(!r.changes){json(res,404,{error:'supplier_not_found'});return;}json(res,200,{supplier:{id,name,phone,notes}});}catch{json(res,400,{error:'bad_request'});}return;}if(req.method==='DELETE'){try{const r=db.prepare('DELETE FROM suppliers WHERE id=? AND NOT EXISTS(SELECT 1 FROM purchases WHERE supplier_id=?)').run(id,id);if(!r.changes){json(res,409,{error:'supplier_has_purchases'});return;}json(res,200,{ok:true});}catch{json(res,400,{error:'bad_request'});}return;}}
  if(req.method==='GET'&&p==='/api/admin/purchases'){const purchases=db.prepare('SELECT p.id,p.supplier_id AS supplierId,s.name AS supplier,p.purchase_date AS date,p.reference,p.total,p.notes FROM purchases p JOIN suppliers s ON s.id=p.supplier_id ORDER BY p.id DESC').all().map(x=>({...x,items:db.prepare('SELECT pi.product_id AS productId,pr.name AS product,pi.quantity,pi.unit_cost AS unitCost,pi.line_total AS lineTotal FROM purchase_items pi JOIN products pr ON pr.id=pi.product_id WHERE pi.purchase_id=?').all(x.id)}));json(res,200,{purchases});return;}
  if(req.method==='POST'&&p==='/api/admin/purchases'){try{const b=await readBody(req),supplierId=Number(b.supplierId),productId=Number(b.productId),quantity=Number(b.quantity),unitCost=Number(b.unitCost),reference=cleanText(b.reference,80),notes=cleanText(b.notes,500);if(!Number.isInteger(supplierId)||!Number.isInteger(productId)||!Number.isInteger(quantity)||quantity<1||quantity>1000000||!Number.isInteger(unitCost)||unitCost<1||unitCost>100000000||String(b.reference||'').length>80||String(b.notes||'').length>500){json(res,400,{error:'invalid_purchase'});return;}db.exec('BEGIN IMMEDIATE');try{const supplier=db.prepare('SELECT id FROM suppliers WHERE id=?').get(supplierId),product=db.prepare('SELECT id,stock,cost_price FROM products WHERE id=?').get(productId);if(!supplier||!product){db.exec('ROLLBACK');json(res,404,{error:!supplier?'supplier_not_found':'product_not_found'});return;}const total=quantity*unitCost;if(!Number.isSafeInteger(total)||total>100000000000){db.exec('ROLLBACK');json(res,400,{error:'invalid_purchase_total'});return;}const date=new Date().toISOString(),r=db.prepare('INSERT INTO purchases(supplier_id,purchase_date,reference,total,notes) VALUES(?,?,?,?,?)').run(supplierId,date,reference,total,notes),purchaseId=Number(r.lastInsertRowid);db.prepare('INSERT INTO purchase_items(purchase_id,product_id,quantity,unit_cost,line_total) VALUES(?,?,?,?,?)').run(purchaseId,productId,quantity,unitCost,total);const newStock=product.stock+quantity;if(!Number.isSafeInteger(newStock)||newStock>1000000000)throw new Error('stock_limit_exceeded');const avgCost=Math.round(((product.stock*product.cost_price)+(quantity*unitCost))/newStock);db.prepare('UPDATE products SET stock=?,cost_price=? WHERE id=?').run(newStock,avgCost,productId);db.exec('COMMIT');json(res,201,{purchase:{id:purchaseId,supplierId,productId,quantity,unitCost,total,date},product:{id:productId,stock:newStock,costPrice:avgCost}});}catch(e){try{db.exec('ROLLBACK')}catch{}json(res,400,{error:e.message==='stock_limit_exceeded'?e.message:'bad_request'});}}catch{json(res,400,{error:'bad_request'});}return;}
  if(req.method==='GET'&&p==='/api/admin/settings'){json(res,200,{settings:getSettings()});return;}
  if(req.method==='GET'&&p==='/api/admin/coupons'){json(res,200,{coupons:couponRows()});return;}
  if(req.method==='POST'&&p==='/api/admin/coupons'){try{const b=await readBody(req),c=validateCoupon(b);if(!c){json(res,400,{error:'invalid_coupon'});return;}if(db.prepare('SELECT code FROM coupons WHERE code=?').get(c.code)){json(res,409,{error:'coupon_code_exists'});return;}db.prepare('INSERT INTO coupons(code,type,value,minimum,expires_on,enabled) VALUES(?,?,?,?,?,?)').run(c.code,c.type,c.value,c.minimum,c.expiresOn,c.enabled?1:0);json(res,201,{coupon:c});}catch{json(res,400,{error:'bad_request'});}return;}
  const couponMatch=p.match(/^\/api\/admin\/coupons\/([A-Z0-9_-]{3,30})$/);if(couponMatch){const code=couponMatch[1];if(req.method==='PUT'){try{const b=await readBody(req),c=validateCoupon({...b,code});if(!c){json(res,400,{error:'invalid_coupon'});return;}const result=db.prepare('UPDATE coupons SET type=?,value=?,minimum=?,expires_on=?,enabled=? WHERE code=?').run(c.type,c.value,c.minimum,c.expiresOn,c.enabled?1:0,code);if(!result.changes){json(res,404,{error:'coupon_not_found'});return;}json(res,200,{coupon:c});}catch{json(res,400,{error:'bad_request'});}return;}if(req.method==='DELETE'){const result=db.prepare('DELETE FROM coupons WHERE code=?').run(code);if(!result.changes){json(res,404,{error:'coupon_not_found'});return;}json(res,200,{ok:true});return;}}
  if(req.method==='PUT'&&p==='/api/admin/settings'){
   try{const b=await readBody(req),fee=Number(b.shippingFee);if(!Number.isFinite(fee)||fee<0||fee>100000){json(res,400,{error:'invalid_shipping_fee'});return;}saveShipping(Math.floor(fee));json(res,200,{settings:getSettings()});}catch{json(res,400,{error:'bad_request'});}return;
  }
  if(req.method==='POST'&&p==='/api/admin/products'){
   try{const b=await readBody(req),product={name:cleanText(b.name,120),cat:cleanText(b.cat,60)||'أخرى',emoji:cleanText(b.emoji,8)||'🛍️',price:Number(b.price),desc:cleanText(b.desc,500),stock:Number(b.stock)};if(!product.name||!Number.isInteger(product.price)||product.price<=0||!Number.isInteger(product.stock)||product.stock<0){json(res,400,{error:'invalid_product'});return;}const r=db.prepare('INSERT INTO products(name,cat,emoji,price,description,stock) VALUES(?,?,?,?,?,?)').run(product.name,product.cat,product.emoji,product.price,product.desc,product.stock);product.id=Number(r.lastInsertRowid);json(res,201,{product});}catch{json(res,400,{error:'bad_request'});}return;
  }
  const stockMatch=p.match(/^\/api\/admin\/products\/(\d+)\/stock$/);if(stockMatch&&req.method==='POST'){
   const id=Number(stockMatch[1]);try{const b=await readBody(req,5000),delta=Number(b.delta);if(!Number.isInteger(delta)||delta===0||Math.abs(delta)>1000000){json(res,400,{error:'invalid_stock_adjustment'});return;}db.exec('BEGIN IMMEDIATE');try{const old=db.prepare('SELECT stock FROM products WHERE id=?').get(id);if(!old){db.exec('ROLLBACK');json(res,404,{error:'product_not_found'});return;}if(old.stock+delta<0){db.exec('ROLLBACK');json(res,409,{error:'insufficient_stock_for_adjustment',stock:old.stock});return;}db.prepare('UPDATE products SET stock=stock+? WHERE id=?').run(delta,id);const stock=db.prepare('SELECT stock FROM products WHERE id=?').get(id).stock;db.exec('COMMIT');json(res,200,{product:{id,stock,adjustment:delta}});}catch(e){try{db.exec('ROLLBACK')}catch{}json(res,400,{error:'bad_request'});}}catch{json(res,400,{error:'bad_request'});}return;
  }
  const prodMatch=p.match(/^\/api\/admin\/products\/(\d+)$/);if(prodMatch){const id=Number(prodMatch[1]),old=db.prepare('SELECT * FROM products WHERE id=?').get(id);if(!old){json(res,404,{error:'product_not_found'});return;}if(req.method==='PUT'){
    try{const b=await readBody(req),upd={name:cleanText(b.name,120),cat:cleanText(b.cat,60)||'أخرى',emoji:cleanText(b.emoji,8)||'🛍️',price:Number(b.price),desc:cleanText(b.desc,500)};if(!upd.name||!Number.isInteger(upd.price)||upd.price<=0){json(res,400,{error:'invalid_product'});return;}db.prepare('UPDATE products SET name=?,cat=?,emoji=?,price=?,description=? WHERE id=?').run(upd.name,upd.cat,upd.emoji,upd.price,upd.desc,id);json(res,200,{product:{id,...upd,stock:old.stock}});}catch{json(res,400,{error:'bad_request'});}return;
   }if(req.method==='DELETE'){const rows=db.prepare('SELECT items_json FROM orders').all();const hasHistory=rows.some(row=>{try{return JSON.parse(row.items_json).some(item=>Number(item.id)===id);}catch{return false;}});if(hasHistory){json(res,409,{error:'product_has_order_history',message:'لا يمكن حذف منتج مرتبط بطلبات سابقة'});return;}db.prepare('DELETE FROM products WHERE id=?').run(id);json(res,200,{ok:true});return;}}
  const orderMatch=p.match(/^\/api\/admin\/orders\/([^/]+)$/);if(orderMatch&&req.method==='PATCH'){
   try{const b=await readBody(req);if(b.status!==undefined&&!validStatus(b.status)){json(res,400,{error:'invalid_status'});return;}const delivery={courierName:cleanText(b.courierName,80),courierPhone:cleanText(b.courierPhone,40),trackingCode:cleanText(b.trackingCode,80)};if((b.courierName!==undefined&&String(b.courierName).length>80)||(b.courierPhone!==undefined&&String(b.courierPhone).length>40)||(b.trackingCode!==undefined&&String(b.trackingCode).length>80)){json(res,400,{error:'delivery_field_too_long'});return;}db.exec('BEGIN IMMEDIATE');try{const o=db.prepare('SELECT * FROM orders WHERE order_no=?').get(decodeURIComponent(orderMatch[1]));if(!o){db.exec('ROLLBACK');json(res,404,{error:'order_not_found'});return;}const nextStatus=b.status===undefined?o.status:b.status,wasCanceled=o.status==='ملغي',willCancel=nextStatus==='ملغي',its=JSON.parse(o.items_json);
    if(wasCanceled&&!willCancel){for(const it of its){const pr=db.prepare('SELECT stock FROM products WHERE id=?').get(it.id);if(!pr||pr.stock<it.qty){db.exec('ROLLBACK');json(res,409,{error:'stock_unavailable_for_reactivation'});return;}}for(const it of its)db.prepare('UPDATE products SET stock=stock-? WHERE id=?').run(it.qty,it.id);}
    else if(!wasCanceled&&willCancel){for(const it of its)db.prepare('UPDATE products SET stock=stock+? WHERE id=?').run(it.qty,it.id);}
    db.prepare('UPDATE orders SET status=?,courier_name=?,courier_phone=?,tracking_code=? WHERE order_no=?').run(nextStatus,b.courierName===undefined?o.courier_name:delivery.courierName,b.courierPhone===undefined?o.courier_phone:delivery.courierPhone,b.trackingCode===undefined?o.tracking_code:delivery.trackingCode,o.order_no);if(o.status!==nextStatus)db.prepare('INSERT INTO order_status_history(order_no,status,changed_at) VALUES(?,?,?)').run(o.order_no,nextStatus,new Date().toISOString());db.exec('COMMIT');const fresh=db.prepare('SELECT * FROM orders WHERE order_no=?').get(o.order_no);json(res,200,{order:{...orderObj(fresh),history:orderHistory(o.order_no)}});
   }catch(e){try{db.exec('ROLLBACK')}catch{}json(res,400,{error:e.message||'bad_request'});}}
   catch{json(res,400,{error:'bad_request'});}return;
  }
 }
 json(res,404,{error:'not_found'});
});
server.listen(PORT,'0.0.0.0',()=>console.log(`SmartMarket server listening on ${PORT}; SQLite: ${DB_FILE}`));
process.on('SIGINT',()=>{try{db.close()}finally{process.exit(0)}});process.on('SIGTERM',()=>{try{db.close()}finally{process.exit(0)}});
