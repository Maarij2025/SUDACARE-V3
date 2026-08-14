import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const dataDir = path.join(root, "data");
const dbPath = path.join(dataDir, "sudacare.sqlite");
const email = String(process.env.SUDACARE_ADMIN_EMAIL || "").trim().toLowerCase();
const password = String(process.env.SUDACARE_ADMIN_PASSWORD || "");

if (!email || !password) {
  console.log("Admin sync skipped: SUDACARE_ADMIN_EMAIL/PASSWORD are not set.");
  process.exit(0);
}

fs.mkdirSync(dataDir, { recursive: true });
const db = new DatabaseSync(dbPath);
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
    expires_at TEXT NOT NULL,
    FOREIGN KEY(admin_id) REFERENCES admins(id) ON DELETE CASCADE
  );
`);

const hash = await new Promise((resolve, reject) => {
  const salt = crypto.randomBytes(16).toString("hex");
  crypto.scrypt(password, salt, 64, (err, derivedKey) => {
    if (err) reject(err);
    else resolve(`${salt}:${derivedKey.toString("hex")}`);
  });
});

const existing = db.prepare("SELECT id FROM admins ORDER BY id LIMIT 1").get();
if (existing) {
  db.prepare("UPDATE admins SET email=?, password_hash=? WHERE id=?").run(email, hash, existing.id);
  db.prepare("DELETE FROM sessions WHERE admin_id=?").run(existing.id);
  console.log(`Admin credentials synchronized for ${email}.`);
} else {
  db.prepare("INSERT INTO admins(email,password_hash) VALUES(?,?)").run(email, hash);
  console.log(`Admin created for ${email}.`);
}
