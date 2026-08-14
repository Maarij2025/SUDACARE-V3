import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

const dataDir = path.join(process.cwd(), "data");
fs.mkdirSync(dataDir, { recursive: true });
const db = new DatabaseSync(path.join(dataDir, "sudacare.sqlite"));

db.exec(`CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);`);
db.exec(`CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT UNIQUE NOT NULL,
  admin_id INTEGER NOT NULL,
  expires_at TEXT NOT NULL
);`);

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  return new Promise((resolve, reject) => crypto.scrypt(password, salt, 64, (err, key) =>
    err ? reject(err) : resolve(`${salt}:${key.toString("hex")}`)
  ));
}

async function upsert(email, password) {
  if (!email || !password) return;
  const hash = await hashPassword(password);
  const existing = db.prepare("SELECT id FROM admins WHERE email=?").get(email);
  if (existing) db.prepare("UPDATE admins SET password_hash=? WHERE id=?").run(hash, existing.id);
  else db.prepare("INSERT INTO admins(email,password_hash) VALUES(?,?)").run(email, hash);
  console.log(`Admin credentials synchronized for ${email}`);
}

await upsert(
  String(process.env.SUDACARE_ADMIN_EMAIL || "admin@sudacare.local").trim().toLowerCase(),
  String(process.env.SUDACARE_ADMIN_PASSWORD || "ChangeMe123!")
);

// Keep the original demo account working temporarily for testing.
await upsert("admin@sudacare.local", "ChangeMe123!");

// Force all existing sessions to expire so the new credentials take effect.
db.exec("DELETE FROM sessions");
console.log("Admin credentials synchronized and old sessions cleared.");
