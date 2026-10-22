// Sinclair AI Lab — site Worker
// Serves the Hugo build (static assets) and three small API routes:
//   POST /api/e              usage events from the decision-lab pages (no cookies, no raw IPs)
//   POST /api/ai/visit-notes  live AI analysis of a sales visit note (S&OP module)
//   GET  /api/stats?key=…     private usage dashboard (key = STATS_KEY secret)
// Everything else falls through to the static site.

const DEFAULT_MODEL = "@cf/google/gemma-4-26b-a4b-it";
const FALLBACK_MODEL = "@cf/mistralai/mistral-small-3.1-24b-instruct";
const BOT_RE = /bot|crawl|spider|slurp|preview|facebookexternalhit|lighthouse|headless/i;
const PAGES = new Set(["index", "case-boss", "ap", "mrp", "sourcing", "production", "ar", "sop", "cash-cycle-lab"]);
const EVENTS = new Set(["view", "scenario", "lever", "lens", "ai_run", "ai_ok", "ai_fail", "copy_email", "module_click"]);

let schemaReady = false;
async function ensureSchema(db) {
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

const today = () => new Date().toISOString().slice(0, 10);
const json = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra } });

// Daily-rotating anonymous visitor id: hash(ip + ua + day + salt). Raw IP is never stored.
async function visitorId(req, env) {
  const ip = req.headers.get("cf-connecting-ip") || "";
  const ua = req.headers.get("user-agent") || "";
  const data = new TextEncoder().encode(`${ip}|${ua}|${today()}|${env.HASH_SALT || "lab"}`);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(buf)].slice(0, 8).map(b => b.toString(16).padStart(2, "0")).join("");
}

function sameSite(req) {
  const origin = req.headers.get("origin");
  if (!origin) return true; // sendBeacon from same page may omit it
  try { return new URL(origin).host === new URL(req.url).host; } catch { return false; }
}

async function handleEvent(req, env) {
  if (!env.DB) return new Response(null, { status: 204 });
  if (!sameSite(req)) return new Response(null, { status: 403 });
  const ua = req.headers.get("user-agent") || "";
  if (BOT_RE.test(ua)) return new Response(null, { status: 204 });
  let body;
  try { body = JSON.parse(await req.text()); } catch { return new Response(null, { status: 400 }); }
  const page = String(body.p || "").slice(0, 40);
  const event = String(body.e || "").slice(0, 20);
  if (!PAGES.has(page) || !EVENTS.has(event)) return new Response(null, { status: 400 });
  const detail = body.d == null ? null : String(body.d).slice(0, 60);
  let ref = null;
  try { if (body.r) { const h = new URL(body.r).host; if (h && h !== new URL(req.url).host) ref = h.slice(0, 80); } } catch {}
  await ensureSchema(env.DB);
  await env.DB.prepare(`INSERT INTO events (ts, day, page, event, detail, visitor, country, ref, mobile) VALUES (?,?,?,?,?,?,?,?,?)`)
    .bind(Date.now(), today(), page, event, detail, await visitorId(req, env), req.cf?.country || null, ref, /Mobi|Android|iPhone/i.test(ua) ? 1 : 0)
    .run();
  return new Response(null, { status: 204 });
}

const VISIT_PROMPT = `你是電子製造公司的客戶情報 agent。請把使用者提供的業務拜訪紀錄整理成可以更新到 CRM 的結構化情報，並列出內部各部門應啟動的配合。只依紀錄內容判斷，不要捏造；推測的部分要在文字中標明「推測」。一律使用繁體中文（台灣用語），精簡。
只回覆一個 JSON 物件，不要加任何說明或 Markdown 標記，格式如下：
{"summary":"一句話重點（40 字內）","signals":[{"type":"需求變化|規格變更|客戶供應鏈|商務條件|關係與風險","content":"內容，40 字內","impact":"高|中|低"}],"actions":[{"dept":"生管|採購|研發|品保|財務|業務","action":"具體行動，30 字內","when":"時間點"}],"risks":["需要注意的風險，最多 3 項"],"next_visit":["下次拜訪要追問的問題，最多 3 項"]}`;

function extractJson(text) {
  if (!text) return null;
  const s = String(text).replace(/<think>[\s\S]*?<\/think>/g, "");
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}

function outputText(r) {
  if (!r) return "";
  if (typeof r === "string") return r;
  if (typeof r.response === "string") return r.response;
  if (r.response && typeof r.response === "object") return JSON.stringify(r.response);
  const c = r.choices?.[0]?.message?.content;
  if (typeof c === "string") return c;
  return "";
}

const arr = x => (Array.isArray(x) ? x : []);
const str = (x, n) => String(x ?? "").slice(0, n);
function cleanResult(d) {
  return {
    summary: str(d.summary, 120),
    signals: arr(d.signals).slice(0, 8).map(x => ({ type: str(x.type, 12), content: str(x.content, 120), impact: ["高", "中", "低"].includes(x.impact) ? x.impact : "中" })),
    actions: arr(d.actions).slice(0, 8).map(x => ({ dept: str(x.dept, 8), action: str(x.action, 100), when: str(x.when, 30) })),
    risks: arr(d.risks).slice(0, 3).map(x => str(x, 120)),
    next_visit: arr(d.next_visit).slice(0, 3).map(x => str(x, 120)),
  };
}

async function runModel(env, model, text) {
  if (env.MOCK_AI === "1") {
    return { response: JSON.stringify({ summary: "（測試模式）客戶新機種進入 EVT，舊機種 Q4 需求下修兩成", signals: [{ type: "需求變化", content: "舊機種 Q4 出貨可能少兩成", impact: "高" }], actions: [{ dept: "生管", action: "下修 Q4 排程並通知採購", when: "本週" }], risks: ["客戶導入第二家組裝廠"], next_visit: ["新機種 DVT 時程是否確定？"] }) };
  }
  return env.AI.run(model, {
    messages: [{ role: "system", content: VISIT_PROMPT }, { role: "user", content: `拜訪紀錄：\n${text}` }],
    max_tokens: 1200,
    temperature: 0.2,
  });
}

async function handleVisitNotes(req, env) {
  if (!sameSite(req)) return json({ error: "forbidden" }, 403);
  if (!env.AI && env.MOCK_AI !== "1") return json({ error: "ai_unavailable" }, 503);
  let body;
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }
  const text = String(body.text || "").trim().slice(0, 3000);
  if (text.length < 20) return json({ error: "too_short" }, 400);

  const visitor = await visitorId(req, env);
  const cap = Number(env.AI_DAILY_CAP || 300);
  const perVisitor = Number(env.AI_PER_VISITOR_10MIN || 5);
  if (env.DB) {
    await ensureSchema(env.DB);
    const day = today();
    const [{ results: t }, { results: v }] = await env.DB.batch([
      env.DB.prepare(`SELECT COUNT(*) AS n FROM ai_calls WHERE day = ?`).bind(day),
      env.DB.prepare(`SELECT COUNT(*) AS n FROM ai_calls WHERE visitor = ? AND ts > ?`).bind(visitor, Date.now() - 600000),
    ]);
    if (t[0].n >= cap) return json({ error: "daily_cap" }, 429);
    if (v[0].n >= perVisitor) return json({ error: "rate_limited" }, 429);
  }

  const started = Date.now();
  const models = [env.AI_MODEL || DEFAULT_MODEL, FALLBACK_MODEL];
  let result = null, used = null;
  for (const m of models) {
    try {
      const d = extractJson(outputText(await runModel(env, m, text)));
      if (d && (d.summary || arr(d.signals).length)) { result = cleanResult(d); used = m; break; }
    } catch (e) { /* try the fallback model */ }
  }
  if (env.DB) {
    await env.DB.prepare(`INSERT INTO ai_calls (ts, day, visitor, ok, ms, model) VALUES (?,?,?,?,?,?)`)
      .bind(Date.now(), today(), visitor, result ? 1 : 0, Date.now() - started, used || models[0]).run();
  }
  if (!result) return json({ error: "no_result" }, 502);
  return json({ ok: true, model: used.split("/").pop(), result });
}

const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

async function handleStats(req, env) {
  const url = new URL(req.url);
  if (!env.STATS_KEY || url.searchParams.get("key") !== env.STATS_KEY) return new Response("Not found", { status: 404 });
  if (!env.DB) return new Response("資料庫尚未設定（DB binding）", { status: 503 });
  await ensureSchema(env.DB);
  const days = Math.min(90, Math.max(1, Number(url.searchParams.get("days") || 28)));
  const since = new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10);
  const q = (sql, ...b) => env.DB.prepare(sql).bind(...b);
  const [tot, byPage, byDay, byEvent, byDetail, byRef, byCountry, ai] = (await env.DB.batch([
    q(`SELECT COUNT(DISTINCT visitor || day) AS visitors, SUM(event='view') AS views, SUM(event='ai_run') AS ai, SUM(event='copy_email') AS mail FROM events WHERE day >= ?`, since),
    q(`SELECT page, SUM(event='view') AS views, COUNT(DISTINCT visitor || day) AS visitors FROM events WHERE day >= ? GROUP BY page ORDER BY views DESC`, since),
    q(`SELECT day, COUNT(DISTINCT visitor) AS visitors, SUM(event='view') AS views FROM events WHERE day >= ? GROUP BY day ORDER BY day`, since),
    q(`SELECT page, event, COUNT(*) AS n FROM events WHERE day >= ? AND event <> 'view' GROUP BY page, event ORDER BY n DESC`, since),
    q(`SELECT page, event, detail, COUNT(*) AS n FROM events WHERE day >= ? AND detail IS NOT NULL GROUP BY page, event, detail ORDER BY n DESC LIMIT 30`, since),
    q(`SELECT COALESCE(ref,'（直接開啟或站內）') AS ref, COUNT(DISTINCT visitor || day) AS visitors FROM events WHERE day >= ? AND event='view' GROUP BY ref ORDER BY visitors DESC LIMIT 15`, since),
    q(`SELECT COALESCE(country,'?') AS country, COUNT(DISTINCT visitor || day) AS visitors FROM events WHERE day >= ? GROUP BY country ORDER BY visitors DESC LIMIT 10`, since),
    q(`SELECT COUNT(*) AS calls, SUM(ok) AS ok, ROUND(AVG(ms)/1000.0,1) AS sec FROM ai_calls WHERE day >= ?`, since),
  ])).map(r => r.results);
  const EV = { view: "瀏覽", scenario: "選情境", lever: "選選項", lens: "看分析視角", ai_run: "執行 AI", ai_ok: "AI 成功", ai_fail: "AI 失敗", copy_email: "複製信箱", module_click: "點模組" };
  for (const r of [...byEvent, ...byDetail]) r.event = EV[r.event] || r.event;
  const t = tot[0] || {};
  const table = (rows, cols) => `<table><thead><tr>${cols.map(c => `<th>${c[1]}</th>`).join("")}</tr></thead><tbody>${rows.map(r => `<tr>${cols.map(c => `<td>${esc(r[c[0]] ?? 0)}</td>`).join("")}</tr>`).join("") || `<tr><td colspan="${cols.length}">尚無資料</td></tr>`}</tbody></table>`;
  const max = Math.max(1, ...byDay.map(d => d.visitors));
  const bars = byDay.map(d => `<div class="bar" title="${d.day}：${d.visitors} 位訪客"><i style="height:${Math.round(d.visitors / max * 100)}%"></i><span>${d.day.slice(5)}</span></div>`).join("");
  const a = ai[0] || {};
  const html = `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>使用統計</title>
<style>:root{--bg:#f3f5f7;--panel:#fff;--ink:#18222d;--muted:#5b6876;--line:#d9dfe6;--accent:#1f5f8b}
@media (prefers-color-scheme:dark){:root{--bg:#11161c;--panel:#18202a;--ink:#e4e9ef;--muted:#93a1b0;--line:#2b3644;--accent:#6fb0dc}}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 "Noto Sans TC","PingFang TC",system-ui,sans-serif;padding:20px max(16px,env(safe-area-inset-left,0px))}
.wrap{max-width:960px;margin:0 auto;display:grid;gap:16px}h1{margin:0;font-size:22px}h2{font-size:15px;margin:0 0 8px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px}.kpi,.panel{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px}
.kpi span{display:block;font-size:12px;color:var(--muted)}.kpi b{font-size:24px;font-variant-numeric:tabular-nums}
table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line)}td:last-child,th:last-child{text-align:right;font-variant-numeric:tabular-nums}
.chart{display:flex;align-items:flex-end;gap:3px;height:140px;overflow-x:auto}.bar{flex:1 0 18px;display:flex;flex-direction:column;align-items:center;height:100%;justify-content:flex-end}
.bar i{display:block;width:100%;background:var(--accent);border-radius:3px 3px 0 0;min-height:2px}.bar span{font-size:10px;color:var(--muted)}
.note{color:var(--muted);font-size:13px}.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px}a{color:var(--accent)}</style></head>
<body><div class="wrap"><h1>現金循環系列：使用統計（近 ${days} 天）</h1>
<p class="note">訪客以「每日匿名代碼」計算：同一台裝置一天算一位，不使用 Cookie、不儲存 IP。已排除常見搜尋引擎與爬蟲。切換期間：<a href="?key=${esc(url.searchParams.get("key"))}&days=7">7 天</a>・<a href="?key=${esc(url.searchParams.get("key"))}&days=28">28 天</a>・<a href="?key=${esc(url.searchParams.get("key"))}&days=90">90 天</a></p>
<div class="kpis"><div class="kpi"><span>訪客（人・日）</span><b>${t.visitors || 0}</b></div><div class="kpi"><span>頁面瀏覽</span><b>${t.views || 0}</b></div><div class="kpi"><span>AI 分析執行</span><b>${t.ai || 0}</b></div><div class="kpi"><span>複製聯絡信箱</span><b>${t.mail || 0}</b></div></div>
<div class="panel"><h2>每日訪客</h2><div class="chart">${bars || '<p class="note">尚無資料</p>'}</div></div>
<div class="grid2"><div class="panel"><h2>各模組</h2>${table(byPage, [["page", "頁面"], ["visitors", "訪客"], ["views", "瀏覽"]])}</div>
<div class="panel"><h2>互動事件</h2>${table(byEvent, [["page", "頁面"], ["event", "事件"], ["n", "次數"]])}</div>
<div class="panel"><h2>最常玩的情境與選項</h2>${table(byDetail, [["page", "頁面"], ["event", "動作"], ["detail", "項目"], ["n", "次數"]])}</div>
<div class="panel"><h2>從哪裡來</h2>${table(byRef, [["ref", "來源網站"], ["visitors", "訪客"]])}</div>
<div class="panel"><h2>國家／地區</h2>${table(byCountry, [["country", "代碼"], ["visitors", "訪客"]])}</div>
<div class="panel"><h2>AI 呼叫</h2><p>共 ${a.calls || 0} 次，成功 ${a.ok || 0} 次，平均 ${a.sec || 0} 秒。每日上限 ${esc(env.AI_DAILY_CAP || 300)} 次。</p></div></div>
</div></body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" } });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    try {
      if (url.pathname === "/api/e" && req.method === "POST") return await handleEvent(req, env);
      if (url.pathname === "/api/ai/visit-notes" && req.method === "POST") return await handleVisitNotes(req, env);
      if (url.pathname === "/api/stats" && req.method === "GET") return await handleStats(req, env);
      if (url.pathname.startsWith("/api/")) return json({ error: "not_found" }, 404);
    } catch (e) {
      return json({ error: "server_error" }, 500);
    }
    return env.ASSETS.fetch(req);
  },
};
