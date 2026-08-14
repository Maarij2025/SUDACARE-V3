import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { URL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, "public");
const DATA_DIR = path.join(__dirname, "data");
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, "sudacare.sqlite");

const db = new DatabaseSync(DB_PATH);
db.exec(`
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'admin',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
try { db.exec("ALTER TABLE admins ADD COLUMN name TEXT NOT NULL DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE admins ADD COLUMN role TEXT NOT NULL DEFAULT 'admin'"); } catch {}

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT UNIQUE NOT NULL,
  admin_id INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  FOREIGN KEY(admin_id) REFERENCES admins(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  category_id INTEGER,
  price REAL NOT NULL DEFAULT 0,
  unit TEXT NOT NULL DEFAULT '1 كجم',
  stock INTEGER NOT NULL DEFAULT 0,
  icon TEXT NOT NULL DEFAULT '🧴',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(category_id) REFERENCES categories(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  city TEXT,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no TEXT UNIQUE NOT NULL,
  customer_id INTEGER NOT NULL,
  total REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'جديد',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(customer_id) REFERENCES customers(id)
);

CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  product_id INTEGER,
  product_name TEXT NOT NULL,
  unit_price REAL NOT NULL,
  qty INTEGER NOT NULL,
  subtotal REAL NOT NULL,
  FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE CASCADE,
  FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE SET NULL
);
`);

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(`${salt}:${derivedKey.toString("hex")}`);
    });
  });
}
function verifyPassword(password, stored) {
  const [salt, keyHex] = String(stored).split(":");
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (err, derivedKey) => {
      if (err) return reject(err);
      const a = Buffer.from(keyHex, "hex");
      const b = Buffer.from(derivedKey.toString("hex"), "hex");
      resolve(a.length === b.length && crypto.timingSafeEqual(a, b));
    });
  });
}
function tokenHash(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}
function json(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extraHeaders });
  res.end(body);
}
function parseCookies(req) {
  const header = req.headers.cookie || "";
  const out = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", chunk => {
      data += chunk;
      if (data.length > 1_000_000) req.destroy();
    });
    req.on("end", () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error("INVALID_JSON")); }
    });
    req.on("error", reject);
  });
}
function authAdmin(req) {
  const token = parseCookies(req).suda_session;
  if (!token) return null;
  const row = db.prepare(`
    SELECT a.id, a.email, s.expires_at
    FROM sessions s JOIN admins a ON a.id=s.admin_id
    WHERE s.token_hash=?
  `).get(tokenHash(token));
  if (!row || new Date(row.expires_at) <= new Date()) return null;
  return { id: row.id, email: row.email };
}
function requireAdmin(req, res) {
  const admin = authAdmin(req);
  if (!admin) {
    json(res, 401, { error: "UNAUTHORIZED", message: "تسجيل دخول الإدارة مطلوب." });
    return null;
  }
  return admin;
}
function makeOrderNo() {
  return "SC-" + Date.now().toString().slice(-8) + "-" + crypto.randomInt(10, 99);
}

async function seed() {
  const adminEmail = process.env.SUDACARE_ADMIN_EMAIL || "admin@sudacare.local";
  const adminPassword = process.env.SUDACARE_ADMIN_PASSWORD || "ChangeMe123!";
  const existingAdmin = db.prepare("SELECT id FROM admins LIMIT 1").get();
  if (!existingAdmin) {
    const hash = await hashPassword(adminPassword);
    db.prepare("INSERT INTO admins(email,password_hash) VALUES(?,?)").run(adminEmail, hash);
    console.log(`Admin created: ${adminEmail} / ${adminPassword}`);
    console.log("IMPORTANT: change the admin password before production use.");
  }

  const count = db.prepare("SELECT COUNT(*) c FROM categories").get().c;
  if (!count) {
    const cats = ["زيوت", "زبدات", "مواد فعالة", "شموع", "مرطبات", "مستحلبات"];
    const insertCat = db.prepare("INSERT INTO categories(name) VALUES(?)");
    for (const c of cats) insertCat.run(c);
  }
  const pcount = db.prepare("SELECT COUNT(*) c FROM products").get().c;
  if (!pcount) {
    const products = [
      ["زيت الجوجوبا","زيوت",85,"1 لتر",24,"🌿"],
      ["زبدة الشيا","زبدات",72,"1 كجم",18,"🥥"],
      ["حمض الهيالورونيك","مواد فعالة",145,"100 جم",9,"💧"],
      ["فيتامين E","مواد فعالة",110,"500 جم",15,"✨"],
      ["شمع العسل","شموع",48,"1 كجم",31,"🍯"],
      ["جلسرين نباتي","مرطبات",39,"1 كجم",42,"🧴"],
      ["زيت اللوز الحلو","زيوت",64,"1 لتر",21,"🌰"],
      ["كحول سيتيل","مستحلبات",57,"1 كجم",12,"⚗️"]
    ];
    const stmt = db.prepare(`
      INSERT INTO products(name,category_id,price,unit,stock,icon)
      VALUES(?,(SELECT id FROM categories WHERE name=?),?,?,?,?)
    `);
    for (const p of products) stmt.run(...p);
  }
}
await seed();

function productsList() {
  return db.prepare(`
    SELECT p.id,p.name,p.price,p.unit,p.stock,p.icon,p.active,
           c.id category_id,c.name category
    FROM products p LEFT JOIN categories c ON c.id=p.category_id
    WHERE p.active=1 ORDER BY p.id DESC
  `).all();
}
function adminProducts() {
  return db.prepare(`
    SELECT p.id,p.name,p.price,p.unit,p.stock,p.icon,p.active,
           c.id category_id,c.name category
    FROM products p LEFT JOIN categories c ON c.id=p.category_id
    ORDER BY p.id DESC
  `).all();
}
function categories() {
  return db.prepare("SELECT id,name FROM categories ORDER BY name").all();
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const method = req.method || "GET";
  const p = url.pathname;

  if (p === "/api/health" && method === "GET") return json(res, 200, { ok: true, app: "SUDACARE V3" });

  if (p === "/api/auth/login" && method === "POST") {
    const body = await parseBody(req);
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    const admin = db.prepare("SELECT * FROM admins WHERE email=?").get(email);
    if (!admin || !(await verifyPassword(password, admin.password_hash))) {
      return json(res, 401, { error: "INVALID_LOGIN", message: "بيانات الدخول غير صحيحة." });
    }
    const token = crypto.randomBytes(32).toString("hex");
    const expires = new Date(Date.now() + 7*24*60*60*1000).toISOString();
    db.prepare("INSERT INTO sessions(token_hash,admin_id,expires_at) VALUES(?,?,?)").run(tokenHash(token), admin.id, expires);
    return json(res, 200, { ok: true, admin: { id: admin.id, email: admin.email, name: admin.name || "", role: admin.role || "admin" } }, {
      "Set-Cookie": `suda_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800`
    });
  }
  if (p === "/api/auth/logout" && method === "POST") {
    const token = parseCookies(req).suda_session;
    if (token) db.prepare("DELETE FROM sessions WHERE token_hash=?").run(tokenHash(token));
    return json(res, 200, { ok: true }, { "Set-Cookie": "suda_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0" });
  }
  if (p === "/api/auth/me" && method === "GET") {
    const admin = authAdmin(req);
    return json(res, 200, { authenticated: !!admin, admin });
  }

  if (p === "/api/products" && method === "GET") return json(res, 200, { products: productsList() });
  if (p === "/api/categories" && method === "GET") return json(res, 200, { categories: categories() });

  if (p === "/api/orders" && method === "POST") {
    const body = await parseBody(req);
    const name = String(body.name || "").trim();
    const phone = String(body.phone || "").trim();
    const city = String(body.city || "").trim();
    const note = String(body.note || "").trim();
    const items = Array.isArray(body.items) ? body.items : [];
    if (!name || !phone || !items.length) return json(res, 400, { error: "INVALID_ORDER", message: "بيانات الطلب غير مكتملة." });

    const tx = db.prepare("BEGIN");
    const commit = db.prepare("COMMIT");
    const rollback = db.prepare("ROLLBACK");
    try {
      tx.run();
      let total = 0;
      const resolved = [];
      for (const item of items) {
        const product = db.prepare("SELECT id,name,price,stock,active FROM products WHERE id=?").get(Number(item.product_id));
        const qty = Math.max(1, Math.floor(Number(item.qty)));
        if (!product || !product.active) throw new Error("PRODUCT_NOT_FOUND");
        if (product.stock < qty) throw new Error(`OUT_OF_STOCK:${product.name}`);
        const subtotal = product.price * qty;
        total += subtotal;
        resolved.push({ product, qty, subtotal });
      }
      let customer = db.prepare("SELECT id FROM customers WHERE phone=? LIMIT 1").get(phone);
      if (customer) {
        db.prepare("UPDATE customers SET name=?,city=?,note=? WHERE id=?").run(name, city, note, customer.id);
      } else {
        customer = { id: Number(db.prepare("INSERT INTO customers(name,phone,city,note) VALUES(?,?,?,?) RETURNING id").get(name,phone,city,note).id) };
      }
      const orderNo = makeOrderNo();
      const orderId = Number(db.prepare("INSERT INTO orders(order_no,customer_id,total) VALUES(?,?,?) RETURNING id").get(orderNo, customer.id, total).id);
      const addItem = db.prepare("INSERT INTO order_items(order_id,product_id,product_name,unit_price,qty,subtotal) VALUES(?,?,?,?,?,?)");
      const dec = db.prepare("UPDATE products SET stock=stock-?, updated_at=CURRENT_TIMESTAMP WHERE id=?");
      for (const r of resolved) {
        addItem.run(orderId, r.product.id, r.product.name, r.product.price, r.qty, r.subtotal);
        dec.run(r.qty, r.product.id);
      }
      commit.run();
      return json(res, 201, { ok: true, order: { id: orderId, order_no: orderNo, total } });
    } catch (e) {
      rollback.run();
      const msg = String(e.message || e);
      return json(res, 400, { error: "ORDER_FAILED", message: msg.startsWith("OUT_OF_STOCK:") ? `المخزون غير كافٍ: ${msg.split(":")[1]}` : "تعذر إنشاء الطلب." });
    }
  }

  const admin = authAdmin(req);
  if (p.startsWith("/api/admin/")) {
    if (!admin) return json(res, 401, { error: "UNAUTHORIZED", message: "تسجيل دخول الإدارة مطلوب." });
  }

  if (p === "/api/admin/stats" && method === "GET") {
    const stats = {
      products: Number(db.prepare("SELECT COUNT(*) c FROM products WHERE active=1").get().c),
      stockUnits: Number(db.prepare("SELECT COALESCE(SUM(stock),0) c FROM products WHERE active=1").get().c),
      orders: Number(db.prepare("SELECT COUNT(*) c FROM orders").get().c),
      orderValue: Number(db.prepare("SELECT COALESCE(SUM(total),0) c FROM orders").get().c),
      customers: Number(db.prepare("SELECT COUNT(*) c FROM customers").get().c)
    };
    return json(res, 200, { stats });
  }
  if (p === "/api/admin/products" && method === "GET") return json(res, 200, { products: adminProducts() });
  if (p === "/api/admin/products" && method === "POST") {
    const b = await parseBody(req);
    const name = String(b.name||"").trim(), category_id=Number(b.category_id)||null, price=Number(b.price)||0,
          unit=String(b.unit||"1 كجم").trim(), stock=Math.max(0,Math.floor(Number(b.stock)||0)), icon=String(b.icon||"🧴");
    if (!name) return json(res, 400, { error:"INVALID_PRODUCT", message:"اسم المنتج مطلوب."});
    const r=db.prepare("INSERT INTO products(name,category_id,price,unit,stock,icon) VALUES(?,?,?,?,?,?) RETURNING id").get(name,category_id,price,unit,stock,icon);
    return json(res,201,{ok:true,id:r.id});
  }
  const productMatch = p.match(/^\/api\/admin\/products\/(\d+)$/);
  if (productMatch && method === "PATCH") {
    const id=Number(productMatch[1]), b=await parseBody(req);
    const cur=db.prepare("SELECT id FROM products WHERE id=?").get(id);
    if(!cur) return json(res,404,{error:"NOT_FOUND"});
    const name=String(b.name||"").trim(), category_id=Number(b.category_id)||null, price=Number(b.price)||0,
          unit=String(b.unit||"1 كجم").trim(), stock=Math.max(0,Math.floor(Number(b.stock)||0)), icon=String(b.icon||"🧴");
    db.prepare("UPDATE products SET name=?,category_id=?,price=?,unit=?,stock=?,icon=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(name,category_id,price,unit,stock,icon,id);
    return json(res,200,{ok:true});
  }
  if (productMatch && method === "DELETE") {
    db.prepare("UPDATE products SET active=0, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(Number(productMatch[1]));
    return json(res,200,{ok:true});
  }
  if (p === "/api/admin/categories" && method === "POST") {
    const b=await parseBody(req), name=String(b.name||"").trim();
    if(!name)return json(res,400,{error:"INVALID_CATEGORY"});
    try {
      const r=db.prepare("INSERT INTO categories(name) VALUES(?) RETURNING id").get(name);
      return json(res,201,{ok:true,category:{id:r.id,name}});
    } catch { return json(res,409,{error:"DUPLICATE_CATEGORY"}); }
  }
  if (p === "/api/admin/categories" && method === "GET") return json(res,200,{categories:categories()});
  const categoryMatch=p.match(/^\/api\/admin\/categories\/(\d+)$/);
  if(categoryMatch && method==="PATCH"){ const b=await parseBody(req), name=String(b.name||"").trim(); if(!name)return json(res,400,{error:"INVALID_CATEGORY",message:"اسم التصنيف مطلوب."}); try{db.prepare("UPDATE categories SET name=? WHERE id=?").run(name,Number(categoryMatch[1]));return json(res,200,{ok:true});}catch{return json(res,409,{error:"DUPLICATE_CATEGORY",message:"اسم التصنيف مستخدم بالفعل."});} }
  if(categoryMatch && method==="DELETE"){ const id=Number(categoryMatch[1]); const used=db.prepare("SELECT COUNT(*) c FROM products WHERE category_id=? AND active=1").get(id).c; if(Number(used)>0)return json(res,409,{error:"CATEGORY_IN_USE",message:"لا يمكن حذف تصنيف مرتبط بمنتجات."}); db.prepare("DELETE FROM categories WHERE id=?").run(id); return json(res,200,{ok:true}); }
  if(p==="/api/admin/users" && method==="GET") return json(res,200,{users:db.prepare("SELECT id,email,name,role,created_at FROM admins ORDER BY id DESC").all()});
  if(p==="/api/admin/users" && method==="POST"){ const b=await parseBody(req),email=String(b.email||"").trim().toLowerCase(),password=String(b.password||""),name=String(b.name||"").trim(),role=String(b.role||"editor"); if(!email||!password)return json(res,400,{error:"INVALID_USER",message:"البريد وكلمة المرور مطلوبان."}); if(password.length<8)return json(res,400,{error:"WEAK_PASSWORD",message:"كلمة المرور يجب أن تكون 8 أحرف على الأقل."}); if(!["admin","manager","editor"].includes(role))return json(res,400,{error:"INVALID_ROLE"}); try{const hash=await hashPassword(password);const r=db.prepare("INSERT INTO admins(email,password_hash,name,role) VALUES(?,?,?,?) RETURNING id").get(email,hash,name,role);return json(res,201,{ok:true,id:r.id});}catch{return json(res,409,{error:"DUPLICATE_USER",message:"البريد مستخدم بالفعل."});} }
  const userMatch=p.match(/^\/api\/admin\/users\/(\d+)$/);
  if(userMatch && method==="PATCH"){ const id=Number(userMatch[1]),b=await parseBody(req),email=String(b.email||"").trim().toLowerCase(),name=String(b.name||"").trim(),role=String(b.role||"editor"),password=String(b.password||""); if(!db.prepare("SELECT id FROM admins WHERE id=?").get(id))return json(res,404,{error:"NOT_FOUND"}); if(!email||!["admin","manager","editor"].includes(role))return json(res,400,{error:"INVALID_USER"}); try{if(password){if(password.length<8)return json(res,400,{error:"WEAK_PASSWORD",message:"كلمة المرور يجب أن تكون 8 أحرف على الأقل."});const hash=await hashPassword(password);db.prepare("UPDATE admins SET email=?,name=?,role=?,password_hash=? WHERE id=?").run(email,name,role,hash,id);}else db.prepare("UPDATE admins SET email=?,name=?,role=? WHERE id=?").run(email,name,role,id);return json(res,200,{ok:true});}catch{return json(res,409,{error:"DUPLICATE_USER",message:"البريد مستخدم بالفعل."});} }
  if(userMatch && method==="DELETE"){ const id=Number(userMatch[1]); if(id===admin.id)return json(res,400,{error:"CANNOT_DELETE_SELF",message:"لا يمكنك حذف المستخدم الحالي."}); db.prepare("DELETE FROM admins WHERE id=?").run(id); return json(res,200,{ok:true}); }

  if (p === "/api/admin/orders" && method === "GET") {
    const orders=db.prepare(`
      SELECT o.id,o.order_no,o.total,o.status,o.created_at,c.name customer_name,c.phone,c.city
      FROM orders o JOIN customers c ON c.id=o.customer_id ORDER BY o.id DESC
    `).all();
    return json(res,200,{orders});
  }
  const orderMatch=p.match(/^\/api\/admin\/orders\/(\d+)$/);
  if(orderMatch && method==="PATCH"){
    const b=await parseBody(req), status=String(b.status||"جديد");
    const allowed=["جديد","قيد التجهيز","جاهز للشحن","تم الشحن","تم التسليم","ملغي"];
    if(!allowed.includes(status)) return json(res,400,{error:"INVALID_STATUS"});
    db.prepare("UPDATE orders SET status=? WHERE id=?").run(status,Number(orderMatch[1]));
    return json(res,200,{ok:true});
  }

  return serveStatic(req,res,p);
}

function contentType(file) {
  const ext = path.extname(file).toLowerCase();
  return { ".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",".css":"text/css; charset=utf-8",".json":"application/json",".png":"image/png",".jpg":"image/jpeg",".jpeg":"image/jpeg",".svg":"image/svg+xml",".webmanifest":"application/manifest+json" }[ext] || "application/octet-stream";
}
function serveStatic(req,res,p) {
  let file = p === "/" ? "/index.html" : p;
  const safe = path.normalize(file).replace(/^(\.\.[/\\])+/, "");
  const target = path.join(PUBLIC, safe);
  if (!target.startsWith(PUBLIC) || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
    return json(res,404,{error:"NOT_FOUND"});
  }
  res.writeHead(200, {"Content-Type":contentType(target),"Cache-Control":"no-cache"});
  fs.createReadStream(target).pipe(res);
}

const port=Number(process.env.PORT)||3000;
const server=http.createServer((req,res)=>{
  route(req,res).catch(err=>{
    console.error(err);
    if(!res.headersSent) json(res,500,{error:"SERVER_ERROR",message:"حدث خطأ داخلي."});
  });
});
server.listen(port,"0.0.0.0",()=>console.log(`SUDACARE V3 running on http://localhost:${port}`));
