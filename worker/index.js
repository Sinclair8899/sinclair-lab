// Sinclair AI Lab — site Worker
// Serves the Hugo build (static assets) and three small API routes:
//   POST /api/e              usage events from the decision-lab pages (no cookies, no raw IPs)
//   POST /api/ai/visit-notes  live AI analysis of a sales visit note (S&OP module)
//   GET  /api/stats?key=…     private usage dashboard (key = STATS_KEY secret)
// Everything else falls through to the static site.

const DEFAULT_MODEL = "@cf/mistralai/mistral-small-3.1-24b-instruct";
const FALLBACK_MODEL = "@cf/google/gemma-4-26b-a4b-it";
const BOT_RE = /bot|crawl|spider|slurp|preview|facebookexternalhit|lighthouse|headless/i;
const PAGES = new Set(["index", "case-boss", "ap", "mrp", "sourcing", "production", "ar", "sop", "crm", "vendor", "cockpit", "neocloud", "signal", "cash-cycle-lab"]);
const EVENTS = new Set(["view", "scenario", "lever", "lens", "ai_run", "ai_ok", "ai_fail", "ai_apply", "copy_email", "module_click"]);

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

const CRM_PROMPT = `你是電子製造公司的 CRM 稽核 agent，負責把業務的拜訪紀錄整理成表單，並把「有書面證據的客戶承諾」和「只是口頭說法」分開。判斷規則：
- 只有提到具體文件或客戶實際行動（例如正式 RFQ、客戶簽認的規格書、測試報告、PO、LOI、書面預測、簽約、付訂金）才算「書面證據」；客戶口頭說「沒問題」「應該會」「很有機會」或業務自己的推測，一律算「口頭」。
- 不要捏造紀錄中沒有的內容；沒有提到的里程碑不要列出。
- 一律使用繁體中文（台灣用語），精簡。
里程碑代碼：M1 正式 RFQ 與報價、M2 客戶規格凍結與技術簽認、M3 EVT 送樣測試通過、M4 DVT 可靠度驗證通過、M5 PVT 小量試產與首張 PO、M6 量產與年度協議。
採購中心角色代碼（依 Kotler 的 B2B 採購中心）：user 使用者／研發工程、influencer 影響者（PM、品保）、buyer 採購、decider 決策者、gatekeeper 把關者。
SPIN 提問分類（依 Rackham）：S 現況提問、P 問題提問、I 影響提問、N 需求回報提問。只分類「我方」在紀錄中提出的問題。
會談結果：「推進」= 客戶自己同意或承諾了一個具體的下一步行動（提供測試報告、提供書面預測、簽文件、安排高層會議、付訂金等）；我方自己安排的下一步（例如我方工程師下週再去）不算客戶行動；「延續」= 沒有具體的客戶行動。
「明確需求」只列客戶明說需要我方提供的東西；我方自己提出的保證不算需求。
「沒有證據支撐的承諾」只列對我方有利、但沒有文件或客戶行動支撐的說法（例如測試會過、會下單、會給預測）；客戶對我方不利的訊息（例如要導入第二家供應商）屬於風險，不要列在這裡。
只回覆一個 JSON 物件，不要加任何說明或 Markdown 標記，格式如下：
{"summary":"一句話重點（40 字內）","milestones":[{"code":"M1-M6","status":"書面證據|口頭","evidence":"依據，30 字內","date":"日期或空字串"}],"forecast":[{"period":"期間","qty":"數量（原文）","basis":"客戶書面|業務口述"}],"buying_center":[{"role":"user|influencer|buyer|decider|gatekeeper","person":"職稱","attitude":"支持|中立|反對|未知"}],"spin":{"S":["問題"],"P":["問題"],"I":["問題"],"N":["問題"]},"needs":{"implied":["隱含需求"],"explicit":["明確需求"]},"outcome":{"type":"推進|延續","reason":"30 字內"},"virtual_commitments":["沒有證據支撐的承諾或樂觀說法，最多 4 項"],"followups":[{"owner":"業務|FAE 工程師|研發|品保|財務|主管","action":"具體行動，30 字內","due":"時間點"}],"next_questions":["下次應該問的影響提問或需求回報提問，最多 3 項"]}`;

const ROLES = ["user", "influencer", "buyer", "decider", "gatekeeper"];
function cleanCrm(d) {
  const q = x => arr(x).slice(0, 4).map(y => str(y, 120));
  return {
    summary: str(d.summary, 120),
    milestones: arr(d.milestones).filter(x => /^M[1-6]$/.test(String(x.code))).slice(0, 6).map(x => ({ code: String(x.code), status: x.status === "書面證據" ? "書面證據" : "口頭", evidence: str(x.evidence, 80), date: str(x.date, 20) })),
    forecast: arr(d.forecast).slice(0, 6).map(x => ({ period: str(x.period, 20), qty: str(x.qty, 30), basis: x.basis === "客戶書面" ? "客戶書面" : "業務口述" })),
    buying_center: arr(d.buying_center).filter(x => ROLES.includes(x.role)).slice(0, 8).map(x => ({ role: x.role, person: str(x.person, 30), attitude: ["支持", "中立", "反對", "未知"].includes(x.attitude) ? x.attitude : "未知" })),
    spin: { S: q(d.spin?.S), P: q(d.spin?.P), I: q(d.spin?.I), N: q(d.spin?.N) },
    needs: { implied: q(d.needs?.implied), explicit: q(d.needs?.explicit) },
    outcome: { type: d.outcome?.type === "推進" ? "推進" : "延續", reason: str(d.outcome?.reason, 80) },
    virtual_commitments: q(d.virtual_commitments),
    followups: arr(d.followups).slice(0, 6).map(x => ({ owner: str(x.owner, 12), action: str(x.action, 100), due: str(x.due, 30) })),
    next_questions: arr(d.next_questions).slice(0, 3).map(y => str(y, 120)),
  };
}

const BRIEF_PROMPT = `你是一家電子製造公司的幕僚，負責把經營駕駛艙算好的結果寫成給老闆看的早報。使用者會給你一份 JSON，內含客戶預測、備料政策、四盞燈號（ok=綠、warn=黃、bad=紅）、最低現金、延遲出貨、積壓料、收付款天期與三種政策比較。規則：
- 只用提供的數字，不要自己計算或推算新數字；引用數字時照抄。
- 用老闆聽得懂的經營語言，精簡，一律繁體中文（台灣用語）。
- 問題只講燈號不是綠的那幾段；決定要具體到「做什麼、誰負責、代價是什麼」；代價必須照「三種政策比較_相對目前」的方向寫，增加就寫增加、減少就寫減少，不要自己猜方向。
- 客戶端的動作優先針對「最大客戶」（金額最大、影響最大），其次才是其他客戶；提問要指向能改變承諾形式的動作（書面預測、NCNR、訂金、縮短客戶票期、延長供應商帳期）。方向要對：我方希望客戶票期變短、供應商帳期變長，不要寫成相反。
只回覆一個 JSON 物件，不要加任何說明或 Markdown 標記，格式如下：
{"headline":"一句話總結（30 字內）","problems":["問題，各 40 字內，最多 3 項"],"decisions":[{"decision":"要做的決定，30 字內","owner":"負責部門","tradeoff":"代價或風險，30 字內"}],"questions":["先去問誰、問什麼，各 40 字內，最多 3 項"]}`;
function cleanBrief(d) {
  return {
    headline: str(d.headline, 80),
    problems: arr(d.problems).slice(0, 3).map(x => str(x, 120)),
    decisions: arr(d.decisions).slice(0, 4).map(x => ({ decision: str(x.decision, 80), owner: str(x.owner, 20), tradeoff: str(x.tradeoff, 100) })),
    questions: arr(d.questions).slice(0, 3).map(x => str(x, 120)),
  };
}

const PCN_PROMPT = `你是電子製造公司的供應商變更管理 agent。使用者會貼上一份供應商的產品變更通知（PCN）。請只依通知內容判讀，不要捏造；沒寫的就寫「未載明」。一律使用繁體中文（台灣用語），精簡。
變更類型依 J-STD-046 的概念分類，可複選：外形、配合、功能、品質、可靠度、製程、據點／封裝廠、材料、標示或包裝、停產（EOL）。
「客戶通知」判斷：據點、製程、材料、可靠度相關的變更，對車用、醫療、伺服器客戶通常需要通知並取得核准，填「需要」；純標示或包裝變更填「可能不需要」。
只回覆一個 JSON 物件，不要加任何說明或 Markdown 標記，格式如下：
{"summary":"一句話重點（40 字內）","change_types":["類型"],"affected_parts":["料號"],"affected_products":"推測受影響的我方產品或客戶，不確定就寫「請比對料號清單」","dates":[{"what":"回覆期限|樣品申請期限|最後下單日|最後出貨日|生效日","date":"日期或未載明"}],"silence_is_acceptance":true或false,"customer_notification":"需要|可能不需要","risks":["風險，各 40 字內，最多 4 項"],"actions":[{"dept":"品保|研發|採購|業務|生管|財務","action":"具體行動，30 字內","due":"期限"}]}`;
function cleanPcn(d) {
  return {
    summary: str(d.summary, 120),
    change_types: arr(d.change_types).slice(0, 6).map(x => str(x, 16)),
    affected_parts: arr(d.affected_parts).slice(0, 10).map(x => str(x, 40)),
    affected_products: str(d.affected_products, 80),
    dates: arr(d.dates).slice(0, 6).map(x => ({ what: str(x.what, 20), date: str(x.date, 30) })),
    silence_is_acceptance: !!d.silence_is_acceptance,
    customer_notification: d.customer_notification === "需要" ? "需要" : "可能不需要",
    risks: arr(d.risks).slice(0, 4).map(x => str(x, 120)),
    actions: arr(d.actions).slice(0, 8).map(x => ({ dept: str(x.dept, 8), action: str(x.action, 100), due: str(x.due, 30) })),
  };
}

const NEO_PROMPT = `你是一家 AI 算力公司的幕僚，負責把經營駕駛艙算好的結果寫成給董事會看的早報。使用者會給你一份 JSON，內含假設、四盞燈號（ok=綠、warn=黃、bad=紅）、最低 EBITDA 利息保障倍數、第 5 年到期牆（含再融資上限與需增資金額）、第 5 年抵押品除以原始借款、最大客戶砍半後的追加資金，以及五種做法（含暫緩擴張基準）的比較。指標名稱照 JSON 的寫法使用，不要改稱「覆蓋率」。規則：
- 只用提供的數字，不要自己計算或推算新數字；引用數字時照抄。
- 用董事會聽得懂的經營語言，精簡，一律繁體中文（台灣用語）。
- 問題只講燈號不是綠的那幾段；決定要具體到「做什麼、誰負責、代價是什麼」，代價照「四種擴張做法」的數字方向寫；確認事項要指向能改變承諾形式或驗證假設的動作（客戶預付、供應商回購保證、延長債務期限、取得 GPU 二手市場報價、降低客戶集中）。
只回覆一個 JSON 物件，不要加任何說明或 Markdown 標記，格式如下：
{"headline":"一句話總結（30 字內）","problems":["問題，各 40 字內，最多 3 項"],"decisions":[{"decision":"要做的決定，30 字內","owner":"負責單位","tradeoff":"代價或風險，30 字內"}],"questions":["先去確認什麼，各 40 字內，最多 3 項"]}`;

const SIGNAL_PROMPT = `你是品牌電子公司的「市場機會卡」agent。使用者會貼上一段前線業務的回報（拜訪通路、客戶或看到競品）。你的工作是把回報填進固定欄位，並為每一格標出證據等級，再把業務自己的推測挑出來。判斷規則：
- 證據等級三種：「明確表示」= 客戶、通路或對方人員自己說的具體事實（競品規格、價格、上架死線、抱怨、書面意向）；「尚待確認」= 對方說了但附條件、含糊、或還沒有書面（例如「價格一樣的話一年六萬台」「應該沒問題」）；「我方推測」= 業務自己的判斷、建議或樂觀預期（例如「這單我們拿得到」「建議開新機」）。欄位沒提到就填空字串並標「尚待確認」。
- 不要捏造回報中沒有的內容；數量、價格照原文。
- 規格缺口填「觸發這次回報的主要缺口」（通常是競品領先我方的規格或價格），其他抱怨接在後面；目標價指通路或客戶要我方達到的價格，對方明說的價差（例如「比我方低 10%」）算明確表示。
- 建議的決定只能從五個選一個：A 新增功能（換相容晶片＋韌體，外殼不動）、B 修改現有設計（重畫主板、重送安規）、C 軟體替代（硬體不動只改韌體設定）、D 先服務特定客群（限量先試）、E 暫時不做（證據不足先問清楚）。承諾量只是「尚待確認」或「我方推測」時，傾向 D 或 E；缺口只是設定或功能開關時傾向 C；缺口超出平台能力才選 B。
- 「先去確認什麼」要指向能把證據等級升級的動作（拿書面意向、問條件、問誰決定上架、拿競品規格頁）。
- 一律使用繁體中文（台灣用語），精簡。不要寫出任何真實公司或品牌名稱；回報中若有，改寫成「競品」「通路」。
只回覆一個 JSON 物件，不要加任何說明或 Markdown 標記，格式如下：
{"summary":"一句話重點（40 字內）","trigger_type":"通路拒絕|競品規格|價格壓力|客戶抱怨|法規變更|其他","trigger_evidence":"明確表示|尚待確認|我方推測","market_window":{"text":"目標檔期或上架死線，原文","evidence":"明確表示|尚待確認|我方推測"},"committed_volume":{"text":"首年量，原文含條件","evidence":"明確表示|尚待確認|我方推測"},"feature_gap":{"category":"規格|價格|外觀機構|軟體功能|品質|其他","detail":"缺口描述，40 字內","evidence":"明確表示|尚待確認|我方推測"},"target_price":{"text":"目標價，原文","evidence":"明確表示|尚待確認|我方推測"},"speculation":["業務自己的推測或建議，原文摘錄，最多 4 項"],"decision":{"option":"A|B|C|D|E","reason":"30 字內"},"confirm_first":["先去確認的事，各 40 字內，最多 3 項"],"actions":[{"dept":"研發|採購|生產|業務|財務|主管","action":"具體行動，30 字內","due":"時間點"}]}`;
const EVI = ["明確表示", "尚待確認", "我方推測"];
function cleanSignal(d) {
  const ev = x => (EVI.includes(x) ? x : "尚待確認");
  const te = o => ({ text: str(o?.text, 80), evidence: ev(o?.evidence) });
  return {
    summary: str(d.summary, 120),
    trigger_type: str(d.trigger_type, 12),
    trigger_evidence: ev(d.trigger_evidence),
    market_window: te(d.market_window),
    committed_volume: te(d.committed_volume),
    feature_gap: { category: str(d.feature_gap?.category, 8), detail: str(d.feature_gap?.detail, 100), evidence: ev(d.feature_gap?.evidence) },
    target_price: te(d.target_price),
    speculation: arr(d.speculation).slice(0, 4).map(x => str(x, 80)),
    decision: { option: /^[A-E]$/.test(String(d.decision?.option)) ? String(d.decision.option) : "E", reason: str(d.decision?.reason, 80) },
    confirm_first: arr(d.confirm_first).slice(0, 3).map(x => str(x, 120)),
    actions: arr(d.actions).slice(0, 6).map(x => ({ dept: str(x.dept, 8), action: str(x.action, 100), due: str(x.due, 30) })),
  };
}

const TASKS = {
  "visit-notes": { prompt: VISIT_PROMPT, label: "拜訪紀錄", maxTokens: 1200, clean: cleanResult, ok: d => d && (d.summary || arr(d.signals).length) },
  "crm-note": { prompt: CRM_PROMPT, label: "拜訪紀錄", maxTokens: 1600, clean: cleanCrm, ok: d => d && (d.summary || arr(d.milestones).length) },
  "pcn-read": { prompt: PCN_PROMPT, label: "變更通知", maxTokens: 1200, clean: cleanPcn, ok: d => d && (d.summary || arr(d.change_types).length) },
  "neocloud-brief": { prompt: NEO_PROMPT, label: "駕駛艙結果（JSON）", maxTokens: 900, clean: cleanBrief, ok: d => d && d.headline },
  "signal-card": { prompt: SIGNAL_PROMPT, label: "前線回報", maxTokens: 1400, clean: cleanSignal, ok: d => d && (d.summary || d.feature_gap) },
  "cockpit-brief": { prompt: BRIEF_PROMPT, label: "駕駛艙結果（JSON）", maxTokens: 900, clean: cleanBrief, ok: d => d && d.headline },
};

const MOCK = {
  "signal-card": { summary: "（測試模式）競品 17 吋機型規格高一級、價低一成，通路要求檔期前有對應機型", trigger_type: "競品規格", trigger_evidence: "明確表示", market_window: { text: "1 月促銷檔期前", evidence: "明確表示" }, committed_volume: { text: "一年 6 萬台（價格與競品相同為條件）", evidence: "尚待確認" }, feature_gap: { category: "規格", detail: "17 吋更新率低一級；底座太重", evidence: "明確表示" }, target_price: { text: "比我方現有機型低 10%", evidence: "明確表示" }, speculation: ["這一單我們拿得到", "建議台灣直接開一個新機型"], decision: { option: "D", reason: "量是口頭且附條件，先限量試銷" }, confirm_first: ["向買手索取書面意向或首批試銷訂單", "確認除價格外還有哪些上架條件"], actions: [{ dept: "研發", action: "確認平台主晶片可否支援高一級更新率", due: "3 天內" }, { dept: "採購", action: "查第二家料源現貨與交期", due: "本週" }] },
  "visit-notes": { summary: "（測試模式）客戶新機種進入 EVT，舊機種 Q4 需求下修兩成", signals: [{ type: "需求變化", content: "舊機種 Q4 出貨可能少兩成", impact: "高" }], actions: [{ dept: "生管", action: "下修 Q4 排程並通知採購", when: "本週" }], risks: ["客戶導入第二家組裝廠"], next_visit: ["新機種 DVT 時程是否確定？"] },
  "pcn-read": { summary: "（測試模式）主晶片封裝測試移轉馬來西亞廠，導線架換供應商", change_types: ["據點／封裝廠", "材料"], affected_parts: ["SOC-7400A", "SOC-7400B"], affected_products: "客戶 A 新一代主機板", dates: [{ what: "回覆期限", date: "發文後 30 日" }, { what: "最後下單日", date: "2026-12-15" }], silence_is_acceptance: true, customer_notification: "需要", risks: ["30 日未回覆視同接受"], actions: [{ dept: "品保", action: "索取樣品與可靠度報告", due: "11/10 前" }] },
  "neocloud-brief": { headline: "（測試模式）到期牆與抵押品兩盞紅燈", problems: ["第 5 年到期牆需再融資"], decisions: [{ decision: "要求客戶預付 20% 合約款", owner: "業務與財務", tradeoff: "客戶可能要求降價" }], questions: ["確認 GPU 二手市場報價"] },
  "cockpit-brief": { headline: "（測試模式）現金與積壓兩盞黃燈，問題在大客戶預測", problems: ["客戶 A 兌現率 80%，依預測備料會積壓"], decisions: [{ decision: "要求客戶 A 書面預測附 NCNR", owner: "業務", tradeoff: "客戶可能要求以票期交換" }], questions: ["問業務：預測有沒有書面？"] },
  "crm-note": { summary: "（測試模式）EVT 樣品通過僅為口頭說法，DVT 時程未確認", milestones: [{ code: "M2", status: "書面證據", evidence: "客戶簽認規格書 v1.2", date: "10/02" }, { code: "M3", status: "口頭", evidence: "PM 口頭表示 EVT 沒問題", date: "" }], forecast: [{ period: "明年 Q2", qty: "10 萬片", basis: "業務口述" }], buying_center: [{ role: "user", person: "硬體研發經理", attitude: "支持" }, { role: "buyer", person: "採購經理", attitude: "中立" }], spin: { S: ["目前用哪家的板子？"], P: [], I: [], N: [] }, needs: { implied: ["散熱方案還沒定"], explicit: [] }, outcome: { type: "延續", reason: "沒有約定下一步行動" }, virtual_commitments: ["「EVT 沒問題」沒有測試報告"], followups: [{ owner: "FAE 工程師", action: "索取 EVT 測試報告", due: "下週" }], next_questions: ["如果散熱方案延後定案，對 DVT 時程影響多大？"] },
};

async function runModel(env, model, text, task) {
  const t = TASKS[task];
  if (env.MOCK_AI === "1") return { response: JSON.stringify(MOCK[task]) };
  return env.AI.run(model, {
    messages: [{ role: "system", content: t.prompt }, { role: "user", content: `${t.label}：\n${text}` }],
    max_tokens: t.maxTokens,
    temperature: 0.2,
  });
}

async function handleAiTask(req, env, task) {
  const T = TASKS[task];
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
      const d = extractJson(outputText(await runModel(env, m, text, task)));
      if (T.ok(d)) { result = T.clean(d); used = m; break; }
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
  const EV = { view: "瀏覽", scenario: "選情境", lever: "選選項", lens: "看分析視角", ai_run: "執行 AI", ai_ok: "AI 成功", ai_fail: "AI 失敗", ai_apply: "套用 AI 建議", copy_email: "複製信箱", module_click: "點模組" };
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
      const ai = url.pathname.match(/^\/api\/ai\/([a-z-]+)$/);
      if (ai && req.method === "POST" && TASKS[ai[1]]) return await handleAiTask(req, env, ai[1]);
      if (url.pathname === "/api/stats" && req.method === "GET") return await handleStats(req, env);
      if (url.pathname.startsWith("/api/")) return json({ error: "not_found" }, 404);
    } catch (e) {
      return json({ error: "server_error" }, 500);
    }
    return env.ASSETS.fetch(req);
  },
};
