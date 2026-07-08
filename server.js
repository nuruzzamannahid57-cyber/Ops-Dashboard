import express from "express";
import { createClient } from "@libsql/client";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

let db;

function initDb() {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url || !authToken) { console.error("Missing env vars"); return null; }
  try { return createClient({ url, authToken }); } catch (e) { console.error("DB init failed:", e.message); return null; }
}

app.get("/api/health", async (req, res) => {
  try {
    if (!db) return res.json({ status: "error", message: "DB not initialized" });
    await db.execute("SELECT 1");
    res.json({ status: "ok", db: "connected" });
  } catch (e) { res.status(503).json({ status: "error", message: e.message }); }
});

app.get("/api/escalations", async (req, res) => {
  try {
    if (!db) return res.status(503).json({ success: false, error: "DB not connected" });
    const result = await db.execute("SELECT * FROM escalations ORDER BY created_at DESC");
    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get("/api/escalations/:refId", async (req, res) => {
  try {
    if (!db) return res.status(503).json({ success: false, error: "DB not connected" });
    const result = await db.execute({ sql: "SELECT * FROM escalations WHERE ref_id = ?", args: [req.params.refId] });
    if (result.rows.length === 0) return res.status(404).json({ success: false, error: "Not found" });
    res.json({ success: true, data: result.rows[0] });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post("/api/escalations/:refId/solve", async (req, res) => {
  try {
    if (!db) return res.status(503).json({ success: false, error: "DB not connected" });
    const { remarks, resolutionType } = req.body;
    if (!remarks) return res.status(400).json({ success: false, error: "Remarks required" });
    const existing = await db.execute({ sql: "SELECT created_at FROM escalations WHERE ref_id = ?", args: [req.params.refId] });
    if (existing.rows.length === 0) return res.status(404).json({ success: false, error: "Not found" });
    const createdAt = new Date(existing.rows[0].created_at);
    const solvedAt = new Date();
    const responseTimeMins = Math.floor((solvedAt - createdAt) / 60000);
    await db.execute({
      sql: "UPDATE escalations SET issue_status = 'Solved', ops_remarks = ?, resolution_type = ?, response_time_mins = ?, solved_at = ?, updated_at = CURRENT_TIMESTAMP WHERE ref_id = ?",
      args: [remarks, resolutionType || null, responseTimeMins, solvedAt.toISOString(), req.params.refId]
    });
    res.json({ success: true, message: "Marked as solved", data: { responseTimeMins } });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post("/api/escalations/:refId/remark", async (req, res) => {
  try {
    if (!db) return res.status(503).json({ success: false, error: "DB not connected" });
    const { remark, newStatus } = req.body;
    if (!remark) return res.status(400).json({ success: false, error: "Remark required" });
    let sql = "UPDATE escalations SET ops_remarks = ?, updated_at = CURRENT_TIMESTAMP";
    const args = [remark];
    if (newStatus) { sql += ", issue_status = ?"; args.push(newStatus); }
    sql += " WHERE ref_id = ?"; args.push(req.params.refId);
    await db.execute({ sql, args });
    res.json({ success: true, message: "Remark added" });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Serve dashboard from separate HTML file
app.get("/", (req, res) => {
  res.sendFile(join(__dirname, "index.html"));
});

async function start() {
  db = initDb();
  if (db) {
    try { await db.execute("SELECT 1"); console.log("DB connected"); }
    catch (e) { console.error("DB test failed:", e.message); }
  }
  app.listen(PORT, () => {
    console.log("OPS Dashboard on port " + PORT);
    console.log("   Dashboard: http://localhost:" + PORT + "/");
    console.log("   Health:    http://localhost:" + PORT + "/api/health");
  });
}

start();
