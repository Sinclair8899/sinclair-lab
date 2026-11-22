/* CRM 客戶承諾 → 供應商備料：交接紀錄、驗證與逐月對帳（虛構示範）
   本輪只處理客戶 A／記憶體 MEM-S2。
   - 交接內容只存在本瀏覽器的交接紀錄（localStorage）；網址只帶交接識別碼。
   - 供應商頁只採用「本機最新、狀態有效、證據欄位齊全且一致」的那一筆；其餘一律以 0 計並說明原因。
   - CRM 的 M6、NCNR 或涵蓋件數一改變已交接的依據（實際變更事件），該筆交接立即失效，直到重新交接；
     寫入前核對該筆仍是本機最新一筆，舊分頁不會讓較新的交接失效；寫入失敗時不算生效。
   - 同料同月取「擬承諾量」與「有效條款涵蓋量」較小值；未用完的涵蓋量不帶到下月。
   核心為純函式（不碰 DOM），可在瀏覽器與 Node 執行。 */
(function (G) {
  "use strict";
  const VERSION = 1;
  const CUSTOMER = "A";
  const PART = "MEM-S2";
  const KEY = "lab.decision.handoff.v1";
  const TYPES = { verbal: "口頭預測", written_forecast: "書面預測（未含專用料承擔條款）", written_ncnr: "書面預測附專用料承擔條款" };
  const ID_RE = /^H-[A-Z0-9]+-[A-Z0-9]+$/;

  /* ---------- 網址：只帶識別碼 ---------- */
  function encode(snapshot) { return "h=" + snapshot.id; }
  function decodeHash(hash) {
    const h = String(hash || "");
    if (!h || h === "#") return { none: true };
    const m = /^#?h=(.*)$/.exec(h);
    if (!m || !ID_RE.test(m[1])) return { error: "網址上的交接識別碼格式不符，無法讀取" };
    return { id: m[1] };
  }

  /* ---------- 建立交接快照（CRM 端） ---------- */
  function makeId(now) { return "H-" + now.getTime().toString(36).toUpperCase() + "-" + Math.random().toString(36).slice(2, 6).toUpperCase(); }
  function basisType(m6Status, ncnrChecked) {
    if (m6Status !== "書面證據") return "verbal";
    return ncnrChecked ? "written_ncnr" : "written_forecast";
  }
  function normCoverage(type, coverage) {
    return type === "written_ncnr" ? coverage.filter(r => r.qty > 0).map(r => ({ part: PART, month: r.month, qty: r.qty })) : [];
  }
  /* CRM 目前輸入所對應的依據（用來比對是否已偏離上次交接） */
  function fingerprint({ m6Status, ncnrChecked, coverage }) {
    const type = basisType(m6Status, ncnrChecked);
    return JSON.stringify({ type, m6: m6Status, ncnr: !!ncnrChecked, coverage: normCoverage(type, coverage) });
  }
  function snapshotFingerprint(s) {
    const e = (s && s.basis && s.basis.evidence) || {};
    return JSON.stringify({ type: s.basis.type, m6: e.m6, ncnr: e.ncnr, coverage: s.coverage });
  }
  function build({ m6Status, ncnrChecked, coverage, document, now }) {
    const t = now || new Date();
    const type = basisType(m6Status, ncnrChecked);
    return {
      v: VERSION, kind: "crm-commitment", id: makeId(t), issued_at: t.toISOString(),
      customer: CUSTOMER, program: "新一代 AI 伺服器主機板",
      basis: { type, document: type === "verbal" ? "" : String(document || ""), evidence: { m6: m6Status, ncnr: !!ncnrChecked } },
      coverage: normCoverage(type, coverage),
    };
  }

  /* ---------- 驗證快照本身：格式、證據欄位齊全且一致 ---------- */
  const isInt = (x, min) => Number.isInteger(x) && x >= min;
  function validate(s) {
    if (!s || typeof s !== "object" || Array.isArray(s)) return { ok: false, reason: "交接紀錄無法讀取" };
    if (s.v !== VERSION) return { ok: false, reason: `版本無效（收到 ${JSON.stringify(s.v ?? null)}，本頁只接受 ${VERSION}）` };
    const miss = [];
    if (s.kind !== "crm-commitment") miss.push("kind");
    if (typeof s.id !== "string" || !ID_RE.test(s.id)) miss.push("id");
    if (typeof s.issued_at !== "string" || isNaN(Date.parse(s.issued_at))) miss.push("issued_at");
    if (typeof s.customer !== "string" || !s.customer) miss.push("customer");
    const b = s.basis;
    if (!b || typeof b !== "object") miss.push("basis");
    else {
      if (!TYPES[b.type]) miss.push("basis.type");
      if (b.type !== "verbal" && (typeof b.document !== "string" || !b.document.trim())) miss.push("basis.document");
      const e = b.evidence;
      if (!e || typeof e !== "object") miss.push("basis.evidence");
      else {
        if (typeof e.m6 !== "string" || !e.m6) miss.push("basis.evidence.m6");
        if (typeof e.ncnr !== "boolean") miss.push("basis.evidence.ncnr");
      }
    }
    if (!Array.isArray(s.coverage)) miss.push("coverage");
    else s.coverage.forEach((r, i) => {
      if (!r || typeof r !== "object") { miss.push(`coverage[${i}]`); return; }
      if (typeof r.part !== "string" || !r.part) miss.push(`coverage[${i}].part`);
      if (!isInt(r.month, 1)) miss.push(`coverage[${i}].month`);
      if (!isInt(r.qty, 0)) miss.push(`coverage[${i}].qty`);
    });
    if (miss.length) return { ok: false, reason: "欄位缺漏或格式錯誤：" + miss.join("、") };
    if (basisType(b.evidence.m6, b.evidence.ncnr) !== b.type) return { ok: false, reason: `證據欄位不一致（M6：${b.evidence.m6}、NCNR：${b.evidence.ncnr ? "有" : "無"}，與依據類型「${TYPES[b.type]}」不符）` };
    const seen = new Set(), dup = [];
    s.coverage.forEach(r => { const k = r.part + "#" + r.month; if (seen.has(k)) dup.push(`${r.part} 第 ${r.month} 月`); seen.add(k); });
    if (dup.length) return { ok: false, reason: "同料同月重複：" + [...new Set(dup)].join("、") };
    if (s.customer !== CUSTOMER) return { ok: false, reason: `客戶不符（交接為客戶 ${s.customer}，本頁對帳客戶 ${CUSTOMER}）` };
    return { ok: true };
  }

  /* ---------- 由網址識別碼找出本機紀錄，並確認是最新且有效 ---------- */
  function resolve(input, ledger) {
    if (!input || input.none) return { ok: false, reason: "未收到交接（直接開啟本頁）" };
    if (input.error) return { ok: false, reason: input.error };
    if (ledger === undefined) return { ok: false, reason: "無法讀取本瀏覽器的交接紀錄，無法確認條款仍有效" };
    const rec = ledger && ledger.records && ledger.records[input.id];
    if (!rec) return { ok: false, reason: "本瀏覽器沒有這筆交接紀錄，無法確認條款仍有效；請回 CRM 頁重新交接" };
    if (rec.status === "withdrawn") return { ok: false, reason: `條款已於 ${fmtTime(rec.withdrawn_at)} 撤回` };
    if (rec.status === "invalidated") return { ok: false, reason: `CRM 依據已於 ${fmtTime(rec.invalidated_at)} 變更（${rec.invalidated_reason || "依據不同"}），這筆交接已失效；請回 CRM 頁重新交接` };
    if (ledger.latest !== input.id) return { ok: false, reason: "這筆交接已被較新的交接取代；請使用 CRM 頁最新的交接" };
    if (rec.status !== "active") return { ok: false, reason: "交接紀錄狀態不明，不認列" };
    const s = rec.snapshot;
    if (!s || s.id !== input.id) return { ok: false, reason: "交接紀錄與網址識別碼不符" };
    const v = validate(s);
    if (!v.ok) return v;
    return { ok: true, snapshot: s };
  }
  function fmtTime(iso) {
    const d = new Date(iso); if (isNaN(d)) return "（時間不明）";
    const p = n => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  /* ---------- 逐月對帳 ----------
     input: decodeHash() 的結果；ledger: 物件、null（沒有紀錄）或 undefined（讀不到）
     plan: [{month, qty}]（供應商端擬承諾量）；unitYuan: 每件料成本（元）；limitWan: 本案例公司自留額度（萬元） */
  function reconcile({ input, ledger, plan, unitYuan, limitWan, part }) {
    const P = part || PART;
    const notes = [];
    let reason = null, basis = null, cov = new Map();
    const r0 = resolve(input, ledger);
    if (!r0.ok) reason = r0.reason;
    else {
      const s = r0.snapshot;
      if (s.basis.type === "verbal") reason = "口頭預測，不認列客戶承擔";
      else if (s.basis.type === "written_forecast") reason = "書面預測未含專用料承擔條款，不認列客戶承擔";
      else {
        basis = s;
        const planMonths = new Set(plan.map(r => r.month));
        s.coverage.forEach(r => {
          if (r.part !== P) notes.push(`條款料件 ${r.part} 與本列 ${P} 不符，不認列`);
          else if (!planMonths.has(r.month)) notes.push(`條款第 ${r.month} 月不在本次擬承諾期間，不認列`);
          else cov.set(r.month, r.qty);
        });
        if (!cov.size) reason = notes.length ? notes.join("；") : "條款沒有涵蓋任何數量";
      }
    }
    if (reason) { cov = new Map(); basis = null; }
    const rows = plan.map(r => {
      const c = cov.get(r.month) || 0;
      const borne = Math.min(r.qty, c);           // 同月取小；未用完的涵蓋量不帶到下月
      return { month: r.month, plan: r.qty, cover: c, borne, retained: r.qty - borne };
    });
    const sum = k => rows.reduce((a, r) => a + r[k], 0);
    const retainedYuan = sum("retained") * unitYuan;
    const limitYuan = Math.round(limitWan * 10000);
    return {
      ok: !reason, reason, basis, notes, rows,
      totals: { plan: sum("plan"), borne: sum("borne"), retained: sum("retained"), retainedYuan, borneYuan: sum("borne") * unitYuan },
      limitYuan, overYuan: Math.max(0, retainedYuan - limitYuan), over: retainedYuan > limitYuan,
      approved: false,                              // 客戶承擔部分風險，不等於公司已核准下單
    };
  }

  /* ---------- 本機交接紀錄（瀏覽器） ---------- */
  function readLedger(store) {
    try { const s = (store || G.localStorage).getItem(KEY); return s ? JSON.parse(s) : null; }
    catch (_) { return undefined; }
  }
  function writeLedger(ledger, store) {
    try { (store || G.localStorage).setItem(KEY, JSON.stringify(ledger)); return true; } catch (_) { return false; }
  }
  function issue(snapshot, store) {
    const l = readLedger(store); if (l === undefined) return false;
    const ledger = l || { records: {}, latest: null };
    const prev = ledger.latest && ledger.records[ledger.latest];
    if (prev && prev.status === "active") { prev.status = "superseded"; prev.superseded_by = snapshot.id; }
    ledger.records[snapshot.id] = { snapshot, status: "active" };
    ledger.latest = snapshot.id;
    return writeLedger(ledger, store);
  }
  /* 只改「指定識別碼」那一筆，而且寫入前再核對它仍是本機最新一筆：舊分頁不得讓較新的交接失效。
     回傳 {ok:true, rec} | {ok:false, why:"read"|"stale"|"inactive"|"write", latest} */
  function setStatusIf(expectedId, status, fields, store) {
    const l = readLedger(store);
    if (l === undefined) return { ok: false, why: "read" };
    if (!l || !l.latest || l.latest !== expectedId) return { ok: false, why: "stale", latest: l ? l.latest : null };
    const rec = l.records[expectedId];
    if (!rec || rec.status !== "active") return { ok: false, why: "inactive", rec };
    rec.status = status; Object.assign(rec, fields);
    return writeLedger(l, store) ? { ok: true, rec } : { ok: false, why: "write" };
  }
  function withdrawIf(expectedId, now, store) { return setStatusIf(expectedId, "withdrawn", { withdrawn_at: (now || new Date()).toISOString() }, store); }
  function invalidateIf(expectedId, reason, now, store) { return setStatusIf(expectedId, "invalidated", { invalidated_at: (now || new Date()).toISOString(), invalidated_reason: reason }, store); }
  /* 舊介面：作用在本機最新一筆（測試用） */
  function withdrawLatest(now, store) { const l = readLedger(store); const r = l && l.latest ? withdrawIf(l.latest, now, store) : null; return r && r.ok ? r.rec : null; }
  function invalidateLatest(reason, now, store) { const l = readLedger(store); const r = l && l.latest ? invalidateIf(l.latest, reason, now, store) : null; return r && r.ok ? r.rec : null; }
  function latest(store) {
    const l = readLedger(store); if (!l || !l.latest) return null;
    return l.records[l.latest] || null;
  }
  /* CRM 目前輸入若偏離最新有效交接，回傳變更說明；否則回 null */
  function drift(rec, cur) {
    if (!rec || rec.status !== "active" || !rec.snapshot) return null;
    const s = rec.snapshot, e = (s.basis && s.basis.evidence) || {};
    if (snapshotFingerprint(s) === fingerprint(cur)) return null;
    const why = [];
    if (e.m6 !== cur.m6Status) why.push(`M6 由「${e.m6}」改為「${cur.m6Status}」`);
    if (e.ncnr !== !!cur.ncnrChecked) why.push(cur.ncnrChecked ? "勾選了 NCNR" : "取消了 NCNR");
    const t = basisType(cur.m6Status, cur.ncnrChecked);
    if (!why.length || JSON.stringify(s.coverage) !== JSON.stringify(normCoverage(t, cur.coverage))) {
      if (t === s.basis.type) why.push("涵蓋件數改變");
    }
    return why.join("、") || "依據不同";
  }

  G.LabHandoff = { VERSION, CUSTOMER, PART, KEY, TYPES, ID_RE, encode, decodeHash, build, basisType, fingerprint, validate, resolve, reconcile,
    readLedger, writeLedger, issue, withdrawIf, invalidateIf, withdrawLatest, invalidateLatest, latest, drift, fmtTime };
})(typeof window !== "undefined" ? window : globalThis);
