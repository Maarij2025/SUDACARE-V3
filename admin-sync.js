import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const DATA_DIR = path.join(process.cwd(), "data");
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, "sudacare.sqlite"));

db.exec(`
CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT UNIQUE NOT NULL,
  admin_id INTEGER NOT NULL,
  expires_at TEXT NOT NULL
);
`);

const email = String(process.env.SUDACARE_ADMIN_EMAIL || "admin@sudacare.local").trim().toLowerCase();
const password = String(process.env.SUDACARE_ADMIN_PASSWORD || "ChangeMe123!");

function hashPassword(value, salt = crypto.randomBytes(16).toString("hex")) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(value, salt, 64, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(`${salt}:${derivedKey.toString("hex")}`);
    });
  });
}

const existing = db.prepare("SELECT id FROM admins ORDER BY id LIMIT 1").get();
const hash = await hashPassword(password);

if (existing) {
  db.prepare("UPDATE admins SET email=?, password_hash=? WHERE id=?").run(email, hash, existing.id);
  db.prepare("DELETE FROM sessions").run();
  console.log(`Admin credentials synchronized for ${email}`);
} else {
  db.prepare("INSERT INTO admins(email,password_hash) VALUES(?,?)").run(email, hash);
  console.log(`Admin created for ${email}`);
}

db.close();
