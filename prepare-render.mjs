import fs from "node:fs";

const serverPath = "server.js";
let server = fs.readFileSync(serverPath, "utf8");
server = server.replace(
  'const adminPassword = process.env.SUDACARE_ADMIN_PASSWORD || "ChangeMe123!";',
  'const adminPassword = process.env.SUDACARE_ADMIN_PASSWORD || "SudaCare@2026!";'
);
const marker = '  const count = db.prepare("SELECT COUNT(*) c FROM categories").get().c;';
const resetBlock = `  if (existingAdmin && process.env.SUDACARE_RESET_ADMIN === "true") {\n    const hash = await hashPassword(adminPassword);\n    db.prepare("UPDATE admins SET email=?, password_hash=? WHERE id=?").run(adminEmail, hash, existingAdmin.id);\n    db.prepare("DELETE FROM sessions").run();\n  }\n\n`;
if (!server.includes('process.env.SUDACARE_RESET_ADMIN')) {
  server = server.replace(marker, resetBlock + marker);
}
fs.writeFileSync(serverPath, server);

const indexPath = "public/index.html";
if (fs.existsSync(indexPath)) {
  let index = fs.readFileSync(indexPath, "utf8");
  index = index.replaceAll("ChangeMe123!", "SudaCare@2026!");
  fs.writeFileSync(indexPath, index);
}
console.log("SUDACARE Render preparation complete");
