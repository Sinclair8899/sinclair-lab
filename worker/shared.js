// Shared helpers for the site Worker (used by index.js and mcp.js)
let schemaReady = false;
export async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL, day TEXT NOT NULL, page TEXT NOT NULL, event TEXT NOT NULL,
      detail TEXT, visitor TEXT, country TEXT, ref TEXT, mobile INTEGER)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_events_day ON events(day)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS ai_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, day TEXT NOT NULL,
      visitor TEXT, ok INTEGER, ms INTEGER, model TEXT)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_ai_day ON ai_calls(day)`),
  ]);
  schemaReady = true;
}

export const today = () => new Date().toISOString().slice(0, 10);
export const json = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra } });

// Daily-rotating anonymous visitor id: hash(ip + ua + day + salt). Raw IP is never stored.
export async function visitorId(req, env) {
  const ip = req.headers.get("cf-connecting-ip") || "";
  const ua = req.headers.get("user-agent") || "";
  const data = new TextEncoder().encode(`${ip}|${ua}|${today()}|${env.HASH_SALT || "lab"}`);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(buf)].slice(0, 8).map(b => b.toString(16).padStart(2, "0")).join("");
}

