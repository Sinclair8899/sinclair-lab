// 現金循環系列 MCP server (Streamable HTTP, stateless, no auth)
// Lets a visitor paste https://lab.sinclairhuang.org/mcp into Claude / ChatGPT as a custom
// connector and run the lab's rule-based models from their own assistant.
// The assistant never computes: every number comes from the same formulas the web pages use.
import "../static/decision-lab/data.js"; // sets globalThis.LAB (shared scenario data, 新台幣萬元)
import { ensureSchema, today, visitorId } from "./shared.js";
const LAB = globalThis.LAB;

const SITE = "https://lab.sinclairhuang.org/decision-lab/";
const fmt = n => (n < 0 ? "−" : "") + Math.abs(Math.round(n)).toLocaleString("zh-TW");
const pct = (x, d = 0) => (x * 100).toFixed(d) + "%";
const num = (v, d, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
const pick = (v, list, d) => (list.includes(v) ? v : d);
const LAMP = { ok: "綠", warn: "黃", bad: "紅" };

/* ---------------- 00 駕駛艙：預測、備料與現金 ---------------- */
function cockpitModel(cfg, pol) {
  const CO = LAB.company, KEY = CO.keyShare, OTH = CO.othShare, MAT = CO.matShare, OPEX = CO.opex, RATE = CO.rate, M = 6;
  const plan = Array(M).fill(0), act = Array(M).fill(0), prep = Array(M).fill(0), ship = Array(M).fill(0), late = Array(M).fill(0), excess = Array(M).fill(0);
  const rows = [];
  cfg.customers.forEach(c => {
    const p = [c.firm, ...c.fc]; while (p.length < M) p.push(p[p.length - 1]);
    const a = p.map((v, i) => (i === 0 ? v : v * c.r));
    const kp = p.map((v, i) => {
      if (i === 0) return v;
      if (i < cfg.lt) return p[i];
      if (pol === "firm") return c.firm;
      if (pol === "adj") return p[i] * c.r * (1 + cfg.ss);
      return p[i] * (1 + cfg.ss);
    });
    const s = a.map((v, i) => { let avail = kp[i]; if (cfg.exp && avail < v) avail += (v - avail) * 0.8; return Math.min(v, avail); });
    const l = a.map((v, i) => v - s[i]);
    const e = kp.map((v, i) => Math.max(0, v - a[i]));
    for (let i = 0; i < M; i++) { plan[i] += p[i]; act[i] += a[i]; prep[i] += kp[i]; ship[i] += s[i]; late[i] += l[i]; excess[i] += e[i]; }
    rows.push({ c, p, a, kp, s, l, e });
  });
  const cash = []; let bal = cfg.cash0, minCash = Infinity, minM = 0, interest = 0, expCost = 0;
  for (let m = 0; m < M; m++) {
    let arIn = 0;
    rows.forEach(x => {
      const lag = Math.round(x.c.dso / 30), idx = m - lag, dep = cfg.depo && x.c.startup ? 0.3 : 0;
      arIn += idx >= 0 ? x.s[idx] * (1 - dep) : x.c.firm;
      if (dep) arIn += (m + 1 < M ? x.a[m + 1] : x.a[M - 1]) * dep;
    });
    let kOut = 0;
    for (let u = -4; u < M + 3; u++) {
      const q = (u < 0 ? prep[0] : u < M ? prep[u] : prep[M - 1]) * KEY, o = u - cfg.lt, payM = u + Math.round(cfg.dpoK / 30);
      if (o === m) kOut += q * cfg.pre; if (payM === m) kOut += q * (1 - cfg.pre);
    }
    let exCost = 0; rows.forEach(x => { exCost += Math.max(0, x.s[m] - x.kp[m]) * KEY * 0.25; }); expCost += exCost;
    const payLag = Math.round(cfg.dpoO / 30), oIdx = m - payLag, oOut = (oIdx >= 0 ? ship[oIdx] : ship[0]) * OTH;
    const it = bal < 0 ? -bal * RATE / 12 : 0; interest += it;
    bal += arIn - kOut - oOut - exCost - OPEX - it; cash.push(bal); if (bal < minCash) { minCash = bal; minM = m; }
  }
  const lateRev34 = late[2] + late[3];
  const excessKey = Math.max(...excess.slice(2, 4)) * KEY;
  let excessOwn = excessKey;
  if (cfg.ncnr) { const bigE = Math.max(0, ...rows.filter(x => x.c.big).map(x => Math.max(x.e[2], x.e[3]))) * KEY; excessOwn = excessKey - bigE * 0.7; }
  const dayRev = act.slice(0, 3).reduce((a, b) => a + b, 0) / 90;
  const dsoW = rows.reduce((a, x) => a + x.c.dso * x.a[0], 0) / act[0];
  const dpoW = (cfg.dpoK * KEY + cfg.dpoO * OTH) / MAT;
  const exDays = excessOwn / (dayRev * KEY);
  const gap = dsoW - dpoW;
  const lamps = {
    cash: minCash < -cfg.line ? "bad" : minCash < cfg.safe ? "warn" : "ok",
    late: lateRev34 > act[2] * 0.15 ? "bad" : lateRev34 > 0 ? "warn" : "ok",
    excess: exDays > 15 ? "bad" : exDays > 5 ? "warn" : "ok",
    gap: gap > 60 ? "bad" : gap > 30 ? "warn" : "ok",
  };
  return { pol, act, prep, cash, minCash, minM, interest, expCost, lateRev34, excessOwn, exDays, dayRev, dsoW, dpoW, gap, lamps, rows };
}

function cockpitCfg(a = {}) {
  const defs = LAB.customers;
  let customers = Array.isArray(a.customers) && a.customers.length ? a.customers.slice(0, 8).map((c, i) => {
    const d = defs[i] || defs[0];
    const fc = Array.isArray(c.forecast) ? c.forecast.slice(0, 3).map((v, j) => num(v, d.fc[j] ?? d.fc[2], 0, 1e7)) : d.fc.slice();
    while (fc.length < 3) fc.push(fc[fc.length - 1] ?? 0);
    return { k: String(c.name || d.k || `客戶 ${i + 1}`).slice(0, 20), firm: num(c.firm, d.firm, 0, 1e7), fc, r: num(c.fulfilment_rate, d.r, 0, 1.5), dso: num(c.dso_days, d.dso, 0, 365), big: !!c.big, startup: !!c.startup };
  }) : defs.map(d => ({ ...d, fc: d.fc.slice() }));
  if (!customers.some(c => c.big)) { let m = customers[0]; customers.forEach(c => { if (c.firm > m.firm) m = c; }); m.big = true; }
  const KM = LAB.keyMaterial, CO = LAB.company;
  return {
    customers,
    pol: pick(a.policy, ["firm", "adj", "full"], "full"),
    ss: num(a.safety_stock, 0.10, 0, 0.5), lt: Math.round(num(a.lead_time_months, KM.leadTimeMonths, 1, 4)),
    dpoK: num(a.key_dpo_days, KM.dpo, 0, 180), pre: num(a.key_prepay, KM.prepay, 0, 1), dpoO: num(a.other_dpo_days, LAB.otherMaterial.dpo, 0, 180),
    cash0: num(a.cash0, CO.cash0, -1e7, 1e7), safe: num(a.safe_cash, CO.safe, 0, 1e7), line: num(a.credit_line, CO.line, 0, 1e7),
    ncnr: !!a.ncnr, depo: !!a.deposit, exp: !!a.expedite,
  };
}

const POLN = { firm: "只備已確認", adj: "依兌現率校正", full: "照預測全備" };
function cockpitTool(a) {
  const cfg = cockpitCfg(a);
  const r = cockpitModel(cfg, cfg.pol);
  const cmp = ["firm", "adj", "full"].map(p => { const x = p === cfg.pol ? r : cockpitModel(cfg, p); return { policy: p, name: POLN[p], late_34: Math.round(x.lateRev34), excess_own: Math.round(x.excessOwn), min_cash: Math.round(x.minCash), expedite_cost: Math.round(x.expCost), interest: Math.round(x.interest) }; });
  const big = r.rows.find(x => x.c.big);
  const probs = [];
  if (r.lamps.excess !== "ok") probs.push(`存貨：客戶 ${big.c.k} 的預測兌現率只有 ${pct(big.c.r)}，${cfg.pol === "full" ? "照預測全備等於替客戶的樂觀付錢" : "即使已依兌現率校正，安全庫存仍會變成積壓"}。先問業務：這份預測有沒有書面？能不能附 NCNR？`);
  if (r.lamps.late !== "ok") probs.push(`交期：第 3–4 個月有 ${fmt(r.lateRev34)} 萬因關鍵料不足出不了貨。${cfg.pol === "firm" ? "只備已確認訂單，等於把兩個月交期的風險全押在急件上。" : "兌現率校正低估了拉貨較準的客戶。"}先問採購：急件補料的成本和機率。`);
  if (r.lamps.cash !== "ok") probs.push(`現金：第 ${r.minM + 1} 個月最低 ${fmt(r.minCash)} 萬。關鍵料要預付 ${pct(cfg.pre)}、供應商帳期只有 ${cfg.dpoK} 天，客戶卻 ${Math.round(r.dsoW)} 天才付款。先問財務：額度夠不夠撐到收款；再問業務：大客戶的票期有沒有交換條件。`);
  if (r.lamps.gap !== "ok") probs.push(`天期：收款比付款慢 ${Math.round(r.gap)} 天，每天 ${fmt(r.dayRev)} 萬，等於長期墊 ${fmt(r.gap * r.dayRev)} 萬。這是結構問題，要在年度議約時處理。`);
  const text = [
    `【老闆駕駛艙】備料政策：${POLN[cfg.pol]}；安全庫存 ${pct(cfg.ss)}；關鍵料交期 ${cfg.lt} 個月、預付 ${pct(cfg.pre)}、帳期 ${cfg.dpoK} 天；一般料帳期 ${cfg.dpoO} 天；期初現金 ${fmt(cfg.cash0)} 萬、安全水位 ${fmt(cfg.safe)} 萬、額度 ${fmt(cfg.line)} 萬${cfg.ncnr ? "；大客戶 NCNR" : ""}${cfg.depo ? "；新創客戶訂金 30%" : ""}${cfg.exp ? "；允許急件補料" : ""}。`,
    `客戶：` + cfg.customers.map(c => `${c.k} 本月確認 ${fmt(c.firm)} 萬、未來三個月預測 ${c.fc.map(fmt).join("／")} 萬、歷史兌現率 ${pct(c.r)}、收款 ${c.dso} 天${c.big ? "（最大客戶）" : ""}`).join("；") + "。",
    `四盞燈：現金 ${LAMP[r.lamps.cash]}（第 ${r.minM + 1} 個月最低 ${fmt(r.minCash)} 萬）；延遲出貨 ${LAMP[r.lamps.late]}（第 3–4 個月 ${fmt(r.lateRev34)} 萬）；存貨積壓 ${LAMP[r.lamps.excess]}（我方承擔 ${fmt(r.excessOwn)} 萬，約 ${Math.round(r.exDays)} 天用量）；收付款天期 ${LAMP[r.lamps.gap]}（加權應收 ${Math.round(r.dsoW)} 天 − 加權應付 ${Math.round(r.dpoW)} 天 = ${Math.round(r.gap)} 天，每天 ${fmt(r.dayRev)} 萬）。`,
    probs.length ? `一眼看出：\n- ` + probs.join("\n- ") : `四盞燈都是綠的：目前的備料政策與交易條件在這組數字下可以兼顧交期與現金。`,
    `三種政策比較（延遲出貨／我方積壓／最低現金／急件加價／利息，萬元）：\n` + cmp.map(x => `- ${x.name}${x.policy === cfg.pol ? "（目前）" : ""}：${fmt(x.late_34)}／${fmt(x.excess_own)}／${fmt(x.min_cash)}／${fmt(x.expedite_cost)}／${fmt(x.interest)}`).join("\n"),
    `判讀規則：延遲出貨與積壓是一組取捨，政策只能在兩者間移動；要同時改善，得改變客戶承諾的形式（書面預測、NCNR、訂金）。方向要對：我方希望客戶票期變短、供應商帳期變長。數字由 ${SITE}cockpit.html 的同一套公式算出，單位新台幣萬元，為教學模型。`,
  ].join("\n\n");
  return { text, data: { inputs: cfg, lamps: r.lamps, min_cash: Math.round(r.minCash), min_cash_month: r.minM + 1, late_34: Math.round(r.lateRev34), excess_own: Math.round(r.excessOwn), excess_days: Math.round(r.exDays), dso_weighted: Math.round(r.dsoW), dpo_weighted: Math.round(r.dpoW), gap_days: Math.round(r.gap), daily_revenue: Math.round(r.dayRev), monthly_cash: r.cash.map(Math.round), comparison: cmp } };
}

/* ---------------- 現金轉換週期 ---------------- */
function cashCycleTool(a = {}) {
  const dso = num(a.dso_days, 90, 0, 400), dio = num(a.dio_days, 60, 0, 400), dpo = num(a.dpo_days, 45, 0, 400);
  const rev = num(a.annual_revenue, 0, 0, 1e12), cogs = num(a.annual_cogs, rev * 0.85, 0, 1e12);
  const ccc = dso + dio - dpo;
  const ar = rev * dso / 365, inv = cogs * dio / 365, ap = cogs * dpo / 365, wc = ar + inv - ap;
  const perDay = { dso: rev / 365, dio: cogs / 365, dpo: cogs / 365 };
  const unit = a.unit ? String(a.unit).slice(0, 10) : "";
  const text = [
    `現金轉換週期 = 應收天數 ${dso} + 存貨天數 ${dio} − 應付天數 ${dpo} = ${ccc} 天。`,
    rev ? `以年營收 ${fmt(rev)}${unit}、年銷貨成本 ${fmt(cogs)}${unit} 計：應收占用 ${fmt(ar)}、存貨占用 ${fmt(inv)}、應付融通 ${fmt(ap)}，淨營運資金占用約 ${fmt(wc)}${unit}。每縮短 1 天應收可釋出約 ${fmt(perDay.dso)}${unit}；每縮短 1 天存貨約 ${fmt(perDay.dio)}${unit}；每延長 1 天應付約 ${fmt(perDay.dpo)}${unit}。` : `未提供年營收，只算天數；提供 annual_revenue（與 annual_cogs）可換算占用金額。`,
    `判讀：天數越長，成長越快越缺錢（營收成長本身會吃現金）。用長期資金（增資、公司債）補營運資金缺口不是沒有成本，只是把問題延到未來：利息或股權稀釋每年都在，缺口沒有消失。優先順序通常是先改交易條件（票期、備料依據、帳期），再談融資。公式見 ${SITE}cash-cycle-lab.html。`,
  ].join("\n\n");
  return { text, data: { dso, dio, dpo, ccc_days: ccc, ar, inventory: inv, ap, working_capital: wc, per_day: perDay } };
}

/* ---------------- 04C 市場機會卡：兩個時鐘 ---------------- */
const SP = {
  xfer: { oral: 5, card: 1 }, dec: { normal: 10, fast: 3 },
  rd: { redesign: { ev: 15, smp: 12, comp: 45, share: 0.6, dev: 300000 }, platform: { ev: 3, smp: 4, comp: 5, share: 0.25, dev: 80000 }, firmware: { ev: 1, smp: 1, comp: 2, share: 0.05, dev: 20000 } },
  src: { single: 14, dual: 3 }, evi: { "書面": 1, "口頭": 0.7, "推測": 0.4 }, ship: 3,
};
const SN = { xfer: { oral: "口頭、信件散落", card: "結構化機會卡" }, dec: { normal: "常規開案流程", fast: "72 小時聯席會" }, rd: { redesign: "重畫主板", platform: "平台化：換晶片＋韌體", firmware: "只改韌體設定" }, src: { single: "單一料源、臨時下單", dual: "雙料源、預綁產能" }, prep: { full: "依承諾量備料", disc: "依證據折現備料" } };
const DECN = { A: "新增功能（換相容晶片＋韌體）", B: "修改現有設計（重畫主板）", C: "軟體替代（只改韌體設定）", D: "先服務特定客群（限量先試）", E: "暫時不做（先問清楚）" };
function clockTool(a = {}) {
  const s = {
    xfer: pick(a.transfer, ["oral", "card"], "oral"), dec: pick(a.decision_process, ["normal", "fast"], "normal"),
    rd: pick(a.rd_approach, ["redesign", "platform", "firmware"], "redesign"), src: pick(a.sourcing, ["single", "dual"], "single"),
    evi: pick(a.volume_evidence, ["書面", "口頭", "推測"], "口頭"), prep: pick(a.prep_basis, ["full", "disc"], "full"),
    win: num(a.window_days, 45, 5, 365), vol: num(a.volume_units, 60000, 0, 1e8), price: num(a.price_usd, 180, 1, 1e5), gm: num(a.gross_margin_pct, 12, 0, 90),
    opt: pick(a.option, ["A", "B", "C", "D", "E"], ""),
  };
  if (s.opt) s.rd = { A: "platform", B: "redesign", C: "firmware", D: "platform", E: "platform" }[s.opt];
  const r = SP.rd[s.rd], x = SP.xfer[s.xfer], d = SP.dec[s.dec], m = s.rd === "firmware" ? 0 : SP.src[s.src];
  const stages = [["傳遞", x], ["可行性評估", r.ev], ["決策", d], ["關鍵料交期", m], ["樣品", r.smp], ["安規／合規", r.comp], ["空運與展示", SP.ship]];
  const demo = x + r.ev + d + m + r.smp + SP.ship, ship = demo + r.comp, late = ship - s.win;
  const share = late <= 0 ? 1 : late <= 30 ? 0.5 : 0.15;
  const scope = s.opt === "D" ? 0.3 : s.opt === "E" ? 0 : 1;
  const units = s.vol * scope, h = SP.evi[s.evi];
  const prep = s.prep === "full" ? units : units * h, sold = Math.min(prep, units * h * share);
  const unitCost = s.price * (1 - s.gm / 100), eo = Math.max(0, prep - sold) * unitCost * r.share, gp = sold * s.price * s.gm / 100, dev = scope ? r.dev : 0, net = gp - eo - dev;
  const loops = Math.round(3650 / demo) / 10;
  const W = v => (Math.round(v / 1000) / 10).toLocaleString("zh-TW");
  const verdict = s.opt === "E" ? `暫時不做：零投入，先把承諾量的證據從「${s.evi}」升級。` : late > 30 ? `這一檔期趕不上（晚 ${late} 天），只能賣到下一檔期的 15%，卻備了 ${fmt(prep)} 台——呆料 ${W(eo)} 萬美元是最大代價。先縮短最長的那一段（平台化、72 小時會、雙料源），或改成「先服務特定客群」。` : late > 0 ? `晚 ${late} 天，只能搭到半檔；再省 ${late} 天就能趕上。` : `趕上死線，早 ${-late} 天。${eo > 0 ? `但承諾量是「${s.evi}」而備料沒折現，仍有 ${W(eo)} 萬美元呆料風險——要嘛拿書面，要嘛依證據備料。` : "量的證據與備料一致，呆料風險最低。"}`;
  const text = [
    `【前線到研發：兩個時鐘】${s.opt ? `決定 ${s.opt}．${DECN[s.opt]}；` : ""}傳遞 ${SN.xfer[s.xfer]}、決策 ${SN.dec[s.dec]}、研發 ${SN.rd[s.rd]}、料源 ${SN.src[s.src]}、承諾量證據「${s.evi}」、${SN.prep[s.prep]}；上架死線 ${s.win} 天、首年承諾量 ${fmt(s.vol)} 台、目標價 $${s.price}、毛利率 ${s.gm}%。`,
    `各段天數：` + stages.filter(z => z[1]).map(z => `${z[0]} ${z[1]} 天`).join("、") + `。到展示 ${demo} 天；到可出貨 ${ship} 天（樣品可展示不等於可出貨）。`,
    `回應速度：到可出貨 ${ship} 天，${late <= 0 ? `比死線早 ${-late} 天` : `比死線晚 ${late} 天`}。學習速度：一年可跑 ${loops} 圈。${s.opt === "E" ? "" : `淨貢獻 ${net < 0 ? "−" : ""}${W(Math.abs(net))} 萬美元（毛利 ${W(gp)} − 呆料 ${W(eo)} − 開發費 ${W(dev)}）；備 ${fmt(prep)} 台、預期賣 ${fmt(sold)} 台、專用料比例 ${pct(r.share)}。`}`,
    `判讀：${verdict}`,
    `公式：趕上死線賣全部、晚 30 天內一半、更晚 15%；預期銷量 = 承諾量 × 證據折現（書面 100%、口頭 70%、推測 40%）× 趕上比例；呆料 =（備料 − 預期銷量）× 單位成本 × 專用料比例（重畫 60%、平台化 25%、韌體 5%）；開發費重畫 30 萬、平台化 8 萬、韌體 2 萬美元。教學用假設，見 ${SITE}signal.html。`,
  ].join("\n\n");
  return { text, data: { inputs: s, stages: Object.fromEntries(stages), days_to_demo: demo, days_to_ship: ship, late_days: late, loops_per_year: loops, prepared_units: Math.round(prep), expected_sold_units: Math.round(sold), gross_profit_usd: Math.round(gp), obsolete_cost_usd: Math.round(eo), dev_cost_usd: dev, net_usd: Math.round(net) } };
}

/* ---------------- 導覽與規則 ---------------- */
function guideTool() {
  const text = `現金循環系列（Cash Cycle Lab）是一組公開的經營決策教學模型，作者 Sinclair Huang（三十年台灣電子、化工與生技產業經營經驗）。核心：現金轉換週期 = 應收天數 + 存貨天數 − 應付天數；每個模組處理其中一段，AI 只負責整理與說明，所有數字由固定規則計算。

可用工具：
- cockpit_diagnose：客戶確認訂單 + 三個月預測 + 兌現率 → 四盞燈（現金、延遲出貨、存貨積壓、收付款天期）與三種備料政策比較。
- cash_cycle：應收／存貨／應付天數 → 現金轉換週期與營運資金占用。
- opportunity_clock：前線訊號到研發回應的兩個時鐘（回應速度、學習速度）、呆料與淨貢獻。

判讀原則（頁面與工具共用）：
1. 客戶的「書面證據」才算承諾；口頭說法與業務推測只能打折備料。
2. 延遲出貨與積壓是一組取捨；要同時改善，要改變客戶承諾的形式（書面預測、NCNR、訂金），不是調政策。
3. 方向要對：希望客戶票期變短、供應商帳期變長。
4. 長期資金補營運資金缺口只是把問題延到未來，不是解決。
5. 樣品可展示不等於可出貨；快是市場、研發、供應與驗證同步協作的結果，不是省掉驗證。

模組網址：${SITE}index.html（總覽）、cockpit.html（00 駕駛艙）、crm.html（04A 客戶承諾）、vendor.html（04B 供應商承諾）、signal.html（04C 市場機會卡）、cash-cycle-lab.html（05 綜合診斷）、neocloud.html（06 AI 算力公司）。所有情境皆為虛構示範，單位新台幣萬元（04C 為美元）。`;
  return { text, data: { site: SITE } };
}

/* ---------------- MCP plumbing ---------------- */
const NUMP = (d, min, max) => ({ type: "number", description: d, ...(min != null ? { minimum: min } : {}), ...(max != null ? { maximum: max } : {}) });
const TOOLS = [
  {
    name: "lab_guide", description: "現金循環系列的導覽、可用工具與判讀原則。回答「這是什麼」「有哪些模組」時先呼叫。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }, run: guideTool,
  },
  {
    name: "cockpit_diagnose",
    description: "老闆駕駛艙：用客戶的本月確認訂單、未來三個月預測與歷史兌現率，依備料政策算出未來六個月的四盞燈（現金、延遲出貨、存貨積壓、收付款天期）、問題在哪一段、以及三種備料政策的比較。所有參數可省略（預設為虛構示範公司）。金額單位新台幣萬元。",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        customers: { type: "array", maxItems: 8, description: "客戶清單；省略則用示範的三家客戶", items: { type: "object", additionalProperties: false, properties: {
          name: { type: "string" }, firm: NUMP("本月已確認訂單營收（萬元）", 0), forecast: { type: "array", items: { type: "number" }, minItems: 1, maxItems: 3, description: "未來第 2–4 個月的預測營收（萬元）" },
          fulfilment_rate: NUMP("歷史預測兌現率 0–1.5，例如 0.8", 0, 1.5), dso_days: NUMP("此客戶的收款天數", 0, 365), big: { type: "boolean", description: "是否最大客戶" }, startup: { type: "boolean", description: "是否新創客戶（可收訂金）" } } } },
        policy: { type: "string", enum: ["firm", "adj", "full"], description: "備料政策：firm 只備已確認、adj 依兌現率校正、full 照預測全備（預設）" },
        safety_stock: NUMP("安全庫存比例 0–0.5，預設 0.10", 0, 0.5), lead_time_months: NUMP("關鍵料交期（月）1–4，預設 2", 1, 4),
        key_dpo_days: NUMP("關鍵料供應商帳期（天），預設 30", 0, 180), key_prepay: NUMP("關鍵料預付比例 0–1，預設 0.2", 0, 1), other_dpo_days: NUMP("一般料帳期（天），預設 60", 0, 180),
        cash0: NUMP("期初現金（萬元），預設 25000"), safe_cash: NUMP("安全水位（萬元），預設 10000", 0), credit_line: NUMP("銀行額度（萬元），預設 30000", 0),
        ncnr: { type: "boolean", description: "最大客戶預測附 NCNR（不可取消不可退）" }, deposit: { type: "boolean", description: "新創客戶付 30% 訂金" }, expedite: { type: "boolean", description: "允許急件補料（加價 25%）" },
      },
    }, run: cockpitTool,
  },
  {
    name: "cash_cycle",
    description: "現金轉換週期：由應收天數、存貨天數、應付天數算出週期天數；若提供年營收（與年銷貨成本），再算營運資金占用與每縮短一天釋出的現金。",
    inputSchema: { type: "object", additionalProperties: false, properties: { dso_days: NUMP("應收天數", 0, 400), dio_days: NUMP("存貨天數", 0, 400), dpo_days: NUMP("應付天數", 0, 400), annual_revenue: NUMP("年營收", 0), annual_cogs: NUMP("年銷貨成本；省略則以營收 85% 估", 0), unit: { type: "string", description: "金額單位文字，例如「萬元」" } } }, run: cashCycleTool,
  },
  {
    name: "opportunity_clock",
    description: "前線到研發的兩個時鐘：給定傳遞方式、決策方式、研發做法、料源、承諾量證據等級、備料依據、上架死線、承諾量、目標價、毛利率（或直接指定五個產品決定 A–E），算出從訊號到展示／到可出貨的天數、一年能跑幾圈、呆料與淨貢獻（美元）。所有參數可省略。",
    inputSchema: { type: "object", additionalProperties: false, properties: {
      transfer: { type: "string", enum: ["oral", "card"], description: "oral 口頭信件散落（5 天）／card 結構化機會卡（1 天）" },
      decision_process: { type: "string", enum: ["normal", "fast"], description: "normal 常規開案（10 天）／fast 72 小時聯席會（3 天）" },
      rd_approach: { type: "string", enum: ["redesign", "platform", "firmware"], description: "redesign 重畫主板／platform 平台化換晶片＋韌體／firmware 只改韌體" },
      sourcing: { type: "string", enum: ["single", "dual"], description: "single 單一料源（14 天）／dual 雙料源預綁產能（3 天）" },
      volume_evidence: { type: "string", enum: ["書面", "口頭", "推測"], description: "首年承諾量的證據等級" },
      prep_basis: { type: "string", enum: ["full", "disc"], description: "full 依承諾量備料／disc 依證據折現備料" },
      window_days: NUMP("通路上架死線（天），預設 45", 5, 365), volume_units: NUMP("首年承諾量（台），預設 60000", 0), price_usd: NUMP("目標零售價（美元），預設 180", 1), gross_margin_pct: NUMP("我方毛利率 %，預設 12", 0, 90),
      option: { type: "string", enum: ["A", "B", "C", "D", "E"], description: "五個產品決定：A 新增功能、B 修改現有設計、C 軟體替代、D 先服務特定客群（三成量）、E 暫時不做" },
    } }, run: clockTool,
  },
];

const INSTRUCTIONS = `這是「現金循環系列」經營決策教學模型的工具集。工具回傳的數字由固定公式計算，請照抄引用、不要自行重算或推算新數字；引用時寫「現金轉換週期」而不是縮寫。情境皆為虛構示範，不代表任何真實公司。回答使用繁體中文（台灣用語）。使用者若給自己公司的數字，提醒他這是教學模型，決策仍需人工確認。`;

const rpc = (id, result) => ({ jsonrpc: "2.0", id, result });
const rpcErr = (id, code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "POST, GET, OPTIONS, DELETE", "access-control-allow-headers": "content-type, mcp-session-id, mcp-protocol-version, accept, authorization" };
const reply = (obj, status = 200) => new Response(obj == null ? null : JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...CORS } });

async function logCall(env, req, tool, ok) {
  if (!env.DB) return;
  try {
    await ensureSchema(env.DB);
    await env.DB.prepare(`INSERT INTO events (ts, day, page, event, detail, visitor, country, ref, mobile) VALUES (?,?,?,?,?,?,?,?,?)`)
      .bind(Date.now(), today(), "mcp", ok ? "mcp_call" : "mcp_fail", String(tool).slice(0, 60), await visitorId(req, env), req.cf?.country || null, (req.headers.get("user-agent") || "").slice(0, 80) || null, 0).run();
  } catch {}
}

async function overCap(env, req) {
  if (!env.DB) return false;
  try {
    await ensureSchema(env.DB);
    const day = today(), v = await visitorId(req, env);
    const [{ results: t }, { results: p }] = await env.DB.batch([
      env.DB.prepare(`SELECT COUNT(*) AS n FROM events WHERE day = ? AND page = 'mcp'`).bind(day),
      env.DB.prepare(`SELECT COUNT(*) AS n FROM events WHERE day = ? AND page = 'mcp' AND visitor = ?`).bind(day, v),
    ]);
    return t[0].n >= Number(env.MCP_DAILY_CAP || 5000) || p[0].n >= Number(env.MCP_PER_VISITOR_DAY || 500);
  } catch { return false; }
}

async function handleOne(msg, env, req) {
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return rpcErr(msg?.id, -32600, "Invalid Request");
  const { id, method, params = {} } = msg;
  const isNotification = id === undefined;
  switch (method) {
    case "initialize":
      return rpc(id, { protocolVersion: typeof params.protocolVersion === "string" && params.protocolVersion >= "2025-03-26" ? params.protocolVersion : "2025-03-26", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "cash-cycle-lab", title: "現金循環系列 Cash Cycle Lab", version: "1.0.0" }, instructions: INSTRUCTIONS });
    case "ping": return rpc(id, {});
    case "tools/list": return rpc(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case "tools/call": {
      const t = TOOLS.find(x => x.name === params.name);
      if (!t) return rpcErr(id, -32602, `Unknown tool: ${params.name}`);
      if (await overCap(env, req)) { await logCall(env, req, t.name, false); return rpc(id, { content: [{ type: "text", text: "今天的使用次數已達上限，請明天再試。" }], isError: true }); }
      try {
        const { text, data } = t.run(params.arguments || {});
        await logCall(env, req, t.name, true);
        return rpc(id, { content: [{ type: "text", text }], structuredContent: data });
      } catch (e) {
        await logCall(env, req, t.name, false);
        return rpc(id, { content: [{ type: "text", text: "這次計算失敗，請檢查參數格式。" }], isError: true });
      }
    }
    default:
      if (isNotification || method.startsWith("notifications/")) return null;
      return rpcErr(id, -32601, `Method not found: ${method}`);
  }
}

export async function handleMcp(req, env) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method === "GET") return new Response("Cash Cycle Lab MCP server. POST JSON-RPC here; or add this URL as a custom connector in Claude.", { status: 405, headers: { allow: "POST", "content-type": "text/plain; charset=utf-8", ...CORS } });
  if (req.method === "DELETE") return new Response(null, { status: 200, headers: CORS });
  if (req.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST", ...CORS } });
  let body;
  try { body = await req.json(); } catch { return reply(rpcErr(null, -32700, "Parse error"), 400); }
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.slice(0, 20).map(m => handleOne(m, env, req)))).filter(Boolean);
    return out.length ? reply(out) : reply(null, 202);
  }
  const out = await handleOne(body, env, req);
  return out ? reply(out) : reply(null, 202);
}
