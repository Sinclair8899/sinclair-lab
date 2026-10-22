/* 現金循環系列：匿名使用紀錄。
   只送出「哪一頁、做了什麼」，不使用 Cookie，不收集輸入內容。
   伺服器端以每日更換的匿名代碼計算訪客數，不儲存 IP。 */
(function () {
  var path = location.pathname.replace(/\/+$/, "");
  var page = (path.split("/").pop() || "index").replace(/\.html$/, "");
  if (page === "decision-lab") page = "index";
  var sent = {};
  function send(e, d) {
    var key = e + "|" + (d || "");
    if (e !== "ai_run" && e !== "ai_ok" && e !== "ai_fail" && sent[key]) return;
    sent[key] = 1;
    var body = JSON.stringify({ p: page, e: e, d: d == null ? null : String(d).slice(0, 60), r: e === "view" ? document.referrer : null });
    try {
      if (navigator.sendBeacon) { navigator.sendBeacon("/api/e", new Blob([body], { type: "application/json" })); return; }
    } catch (err) {}
    try { fetch("/api/e", { method: "POST", body: body, headers: { "content-type": "application/json" }, keepalive: true }).catch(function () {}); } catch (err) {}
  }
  window.labTrack = send;
  if (location.protocol === "file:") { window.labTrack = function () {}; return; }
  send("view");

  document.addEventListener("click", function (ev) {
    var t = ev.target;
    if (!t || !t.closest) return;
    var el = t.closest("[data-track]");
    if (el) { var p = el.getAttribute("data-track").split(":"); send(p[0], p.slice(1).join(":") || null); return; }
    var sc = t.closest(".sc[data-k]");
    if (sc) { send("scenario", sc.getAttribute("data-k")); return; }
    var tab = t.closest(".tab[data-lens]");
    if (tab) { send("lens", tab.getAttribute("data-lens")); return; }
    var opt = t.closest("[data-opt]");
    if (opt) { send("lever", "opt" + opt.getAttribute("data-opt")); return; }
    if (t.closest("#copy, #copyMail")) { send("copy_email"); return; }
    var a = t.closest("a[href$='.html']");
    if (a && !/^https?:/i.test(a.getAttribute("href"))) { send("module_click", a.getAttribute("href").replace(/\.html$/, "")); }
  }, true);

  document.addEventListener("change", function (ev) {
    var t = ev.target;
    if (!t || !t.matches || !t.matches("input[type=radio], input[type=checkbox]")) return;
    var name = t.name || t.id || "";
    send("lever", name + (t.type === "radio" ? "=" + t.value : (t.checked ? "+" : "-")));
  }, true);
})();
