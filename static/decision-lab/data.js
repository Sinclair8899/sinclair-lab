/* 現金循環系列：共用情境資料（虛構示範）
   老闆駕駛艙（cockpit）、CRM 客戶端（crm）、供應商端（vendor）都從這裡取數字，
   任何一頁改了數字，其他頁自動跟著變，避免口徑不一致。單位：新台幣萬元。 */
window.LAB = {
  company: {
    name: "某 AI 伺服器板卡製造商（虛構）",
    matShare: 0.85,   // 料成本占營收
    keyShare: 0.45,   // 其中關鍵零組件（主晶片、記憶體、特殊連接器）占營收
    othShare: 0.40,   // 一般料占營收
    opex: 4000,       // 每月固定費用
    cash0: 25000, safe: 10000, line: 30000, rate: 0.03,
  },
  // 客戶：第 1 月確認訂單、第 2–4 月預測、兌現率（實際／預測）、帳期
  customers: [
    { k: "A", name: "雲端客戶 A（AI 伺服器）", firm: 30000, fc: [32000, 36000, 40000], r: 0.80, dso: 90, big: true,
      program: { name: "新一代 AI 伺服器主機板", unitPrice: 1.2, annualUnits: 400000, quarterlyUnits: 100000, stage: "EVT",
                 note: "業務口述年量 40 萬片、單價約 1.2 萬元，年營收約 48 億；相當於每月約 40,000 萬，與駕駛艙第 4 個月的預測一致。" } },
    { k: "B", name: "工控客戶 B", firm: 8000, fc: [8000, 8500, 8500], r: 0.97, dso: 60 },
    { k: "C", name: "新創客戶 C", firm: 3000, fc: [6000, 9000, 12000], r: 0.50, dso: 45, startup: true },
  ],
  // 關鍵零組件：交期、供應商帳期、預付
  keyMaterial: { leadTimeMonths: 2, dpo: 30, prepay: 0.20,
    // 關鍵料的組成（占關鍵料金額）
    mix: [
      { k: "soc", name: "主晶片原廠 S1", share: 0.50, kraljic: "策略型", sources: 1, terms: "配額制、月結 30 天、下單預付 20%" },
      { k: "mem", name: "記憶體原廠 S2", share: 0.35, kraljic: "策略型", sources: 1, terms: "配額制、要求簽長約鎖量" },
      { k: "con", name: "特殊連接器廠 S3", share: 0.15, kraljic: "瓶頸型", sources: 1, terms: "客戶指定料、交期 16 週" },
    ] },
  otherMaterial: { dpo: 60, mix: [
      { k: "pcb", name: "PCB 廠 S4／S5", share: 0.55, kraljic: "槓桿型", sources: 2, terms: "月結 60 天、兩家競價" },
      { k: "pas", name: "被動元件（多家）", share: 0.45, kraljic: "一般型", sources: 4, terms: "VMI 寄售、月結 60 天" },
    ] },
};
/* 由上面推導的共用數字 */
(function (L) {
  const c = L.company, A = L.customers[0];
  L.derived = {
    firmRevenue: L.customers.reduce((s, x) => s + x.firm, 0),                       // 第 1 月確認營收 41,000
    m4Revenue: L.customers.reduce((s, x) => s + x.fc[2], 0),                        // 第 4 月預測營收 60,500
    aMonthlyRevenue: A.program.annualUnits / 12 * A.program.unitPrice,              // 客戶 A 新機種量產後每月營收 40,000
    aQuarterKeyMaterial: A.program.quarterlyUnits * A.program.unitPrice * c.keyShare, // 一季量產關鍵料 54,000
    aMonthKeyMaterial: A.program.annualUnits / 12 * A.program.unitPrice * c.keyShare, // 一個月量產關鍵料 18,000
    keyMonthlyAtM4: L.customers.reduce((s, x) => s + x.fc[2], 0) * c.keyShare,       // 第 4 月關鍵料需求 27,225
  };
})(window.LAB);
