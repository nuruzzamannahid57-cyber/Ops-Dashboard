import express from "express";
import { createClient } from "@libsql/client";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import cookieParser from "cookie-parser";
import { OAuth2Client } from "google-auth-library";
import jwt from "jsonwebtoken";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const JWT_SECRET = process.env.JWT_SECRET;
const ALLOWED_DOMAIN = "carrybee.com";
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

app.use(express.json());
app.use(cookieParser());
app.use((req, res, next) => {
  // Reflect the request origin instead of "*" so credentialed (cookie) requests work correctly.
  res.header("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.header("Access-Control-Allow-Credentials", "true");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// ---- Auth middleware ----
function requireAuth(req, res, next) {
  const token = req.cookies?.session;
  if (!token) {
    if (req.path.startsWith("/api/")) return res.status(401).json({ error: "Not authenticated" });
    return res.redirect("/login.html");
  }
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    if (req.path.startsWith("/api/")) return res.status(401).json({ error: "Session expired" });
    return res.redirect("/login.html");
  }
}

// ---- Auth routes (public, no auth required) ----
app.post("/api/auth/google", async (req, res) => {
  try {
    const { credential } = req.body;
    if (!credential) return res.status(400).json({ error: "Missing credential" });

    const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: GOOGLE_CLIENT_ID });
    const payload = ticket.getPayload();
    const email = payload.email || "";
    const isAllowed =
      payload.email_verified &&
      ((payload.hd && payload.hd === ALLOWED_DOMAIN) || email.toLowerCase().endsWith(`@${ALLOWED_DOMAIN}`));

    if (!isAllowed) return res.status(403).json({ error: "Access restricted to @carrybee.com accounts" });

    const sessionToken = jwt.sign(
      { email, name: payload.name, picture: payload.picture },
      JWT_SECRET,
      { expiresIn: "12h" }
    );
    res.cookie("session", sessionToken, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      maxAge: 12 * 60 * 60 * 1000,
    });
    res.json({ ok: true, user: { email, name: payload.name, picture: payload.picture } });
  } catch (e) {
    console.error("Google auth error:", e.message);
    res.status(401).json({ error: "Invalid Google token" });
  }
});

app.get("/api/auth/me", (req, res) => {
  const token = req.cookies?.session;
  if (!token) return res.status(401).json({ error: "Not authenticated" });
  try {
    res.json({ ok: true, user: jwt.verify(token, JWT_SECRET) });
  } catch {
    res.status(401).json({ error: "Session expired" });
  }
});

app.post("/api/auth/logout", (req, res) => {
  res.clearCookie("session");
  res.json({ ok: true });
});

// Serve login.html and its assets without auth
app.get("/login.html", (req, res) => res.sendFile(join(__dirname, "login.html")));
app.use("/logo.png", express.static(join(__dirname, "logo.png")));

// Everything below this line requires a valid session
app.use(requireAuth);

// Serve static files (logo)
app.use(express.static(__dirname));

let db;

function initDb() {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url || !authToken) { console.error("Missing env vars"); return null; }
  try { return createClient({ url, authToken }); } catch (e) { console.error("DB init failed:", e.message); return null; }
}

async function getTableColumns(tableName) {
  try {
    const result = await db.execute("SELECT name FROM pragma_table_info('" + tableName + "')");
    const columns = new Set();
    for (const row of result.rows) {
      columns.add(row.name);
    }
    return columns;
  } catch (e) {
    console.error("Failed to get columns:", e.message);
    return new Set();
  }
}

async function runMigrations() {
  if (!db) return;
  console.log("Running database migrations...");

  const columns = await getTableColumns("escalations");
  console.log("Existing columns:", Array.from(columns).join(", "));

  const migrations = [
    { col: "ops_remarks", sql: "ALTER TABLE escalations ADD COLUMN ops_remarks TEXT" },
    { col: "resolution_type", sql: "ALTER TABLE escalations ADD COLUMN resolution_type TEXT" },
    { col: "response_time_mins", sql: "ALTER TABLE escalations ADD COLUMN response_time_mins INTEGER" },
    { col: "solved_at", sql: "ALTER TABLE escalations ADD COLUMN solved_at DATETIME" },
    { col: "updated_at", sql: "ALTER TABLE escalations ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP" }
  ];

  for (const mig of migrations) {
    if (columns.has(mig.col)) {
      console.log("  Column already exists:", mig.col);
      continue;
    }
    try {
      await db.execute(mig.sql);
      console.log("  Added column:", mig.col);
    } catch (e) {
      console.error("  Failed to add column", mig.col + ":", e.message);
    }
  }
  console.log("Migrations complete.");
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

app.get("/", (req, res) => {
  res.sendFile(join(__dirname, "index.html"));
});

async function start() {
  db = initDb();
  if (db) {
    try { 
      await db.execute("SELECT 1"); 
      console.log("DB connected");
      await runMigrations();
    }
    catch (e) { console.error("DB test failed:", e.message); }
  }
  app.listen(PORT, () => {
    console.log("OPS Dashboard on port " + PORT);
    console.log("   Dashboard: http://localhost:" + PORT + "/");
    console.log("   Health:    http://localhost:" + PORT + "/api/health");
  });
}

start();
