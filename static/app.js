// ===== 共通 =====
const $ = (s) => document.querySelector(s);
const CSS = getComputedStyle(document.documentElement);
const C = (v) => CSS.getPropertyValue(v).trim();

const fmt = (v, d = 0) =>
  v == null ? "—" : Number(v).toLocaleString("ja-JP", { minimumFractionDigits: d, maximumFractionDigits: d });
const sign = (v, d = 2, suffix = "") => (v == null ? "—" : (v > 0 ? "+" : "") + fmt(v, d) + suffix);
const cls = (v) => (v == null || v === 0 ? "" : v > 0 ? "up" : "down");
const big = (v) => {
  if (v == null) return "—";
  const a = Math.abs(v);
  if (a >= 1e12) return fmt(v / 1e12, 2) + "兆";
  if (a >= 1e8) return fmt(v / 1e8, 1) + "億";
  if (a >= 1e4) return fmt(v / 1e4, 1) + "万";
  return fmt(v);
};
async function api(url, opts) {
  const r = await fetch(url, opts);
  const j = await r.json();
  if (!r.ok || j.error) throw new Error(j.error || r.statusText);
  return j;
}
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// 時計
setInterval(() => {
  $("#clock").textContent = new Date().toLocaleString("ja-JP", { month: "2-digit", day: "2-digit", weekday: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}, 1000);

// ===== ナビゲーション =====
const loaded = {};
function showView(name) {
  document.querySelectorAll(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === "view-" + name));
  if (name === "market" && !loaded.market) { loaded.market = true; loadMarket(); }
  if (name === "news" && !loaded.news) { loaded.news = true; loadNews(); }
  if (name === "chart" && chart) chart.applyOptions({ width: $("#chart").clientWidth });
}
document.querySelectorAll(".nav-item").forEach((b) => b.addEventListener("click", () => showView(b.dataset.view)));

$("#refreshBtn").addEventListener("click", async () => {
  $("#refreshBtn").textContent = "更新中…";
  await api("/api/refresh", { method: "POST" });
  loaded.market = loaded.news = false;
  await loadStocks();
  if (current) await loadStock(current.code, current.name);
  const active = document.querySelector(".nav-item.active").dataset.view;
  showView(active);
  $("#refreshBtn").textContent = "↻ データ更新";
});

// ===== 機能1: 登録銘柄 =====
let stocks = [];
let current = null;
let period = "6mo";

async function loadStocks() {
  stocks = await api("/api/stocks");
  renderStockList();
  // 価格は各銘柄ごとに非同期で埋める
  stocks.forEach(async (s) => {
    try {
      const d = await api(`/api/stock/${encodeURIComponent(s.code)}?period=${period}`);
      s.summary = d.summary;
      renderStockList();
    } catch { /* 無視 */ }
  });
}

function renderStockList() {
  $("#stockCount").textContent = stocks.length;
  $("#stockList").innerHTML = stocks.map((s) => {
    const sm = s.summary || {};
    return `<li class="stock-item ${current && current.code === s.code ? "active" : ""}" data-code="${esc(s.code)}">
      <span class="si-code">${esc(s.code)}</span>
      <span class="si-price">${sm.close != null ? fmt(sm.close, 1) : "…"}</span>
      <span class="si-name">${esc(s.name)}</span>
      <span class="si-chg ${cls(sm.changePct)}">${sm.changePct != null ? sign(sm.changePct, 2, "%") : ""}</span>
      <button class="si-del" title="登録解除" data-del="${esc(s.code)}">✕</button>
    </li>`;
  }).join("");
}

$("#stockList").addEventListener("click", async (e) => {
  const del = e.target.closest("[data-del]");
  if (del) {
    e.stopPropagation();
    const code = del.dataset.del;
    stocks = await api(`/api/stocks/${encodeURIComponent(code)}`, { method: "DELETE" });
    renderStockList();
    loadStocks();
    return;
  }
  const li = e.target.closest(".stock-item");
  if (li) {
    const s = stocks.find((x) => x.code === li.dataset.code);
    showView("chart");
    loadStock(s.code, s.name);
  }
});

$("#addForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const code = $("#addCode").value.trim();
  const btn = $("#addForm button");
  const msg = $("#addMsg");
  btn.disabled = true;
  msg.className = "add-msg";
  msg.textContent = `${code} を確認中…`;
  try {
    await api("/api/stocks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }) });
    msg.textContent = `${code} を登録しました`;
    $("#addCode").value = "";
    await loadStocks();
    const s = stocks.find((x) => x.code === code.toUpperCase());
    if (s) loadStock(s.code, s.name);
  } catch (err) {
    msg.className = "add-msg err";
    msg.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

// ===== 機能1: チャート =====
let chart, candle, ma5, ma25, vol;
let rows = [];

function initChart() {
  const el = $("#chart");
  chart = LightweightCharts.createChart(el, {
    width: el.clientWidth,
    height: el.clientHeight,
    layout: { background: { color: "transparent" }, textColor: C("--muted"), fontFamily: "IBM Plex Mono", fontSize: 11 },
    grid: { vertLines: { color: "#1f242d" }, horzLines: { color: "#1f242d" } },
    rightPriceScale: { borderColor: C("--line"), scaleMargins: { top: 0.06, bottom: 0.26 } },
    timeScale: { borderColor: C("--line"), rightOffset: 4 },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    localization: { locale: "ja-JP", priceFormatter: (p) => fmt(p, 1) },
  });
  candle = chart.addCandlestickSeries({
    upColor: C("--up"), downColor: C("--down"), borderUpColor: C("--up"), borderDownColor: C("--down"),
    wickUpColor: C("--up"), wickDownColor: C("--down"),
  });
  ma5 = chart.addLineSeries({ color: C("--ma5"), lineWidth: 1.5, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
  ma25 = chart.addLineSeries({ color: C("--ma25"), lineWidth: 1.5, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
  vol = chart.addHistogramSeries({ priceScaleId: "vol", priceFormat: { type: "volume" }, priceLineVisible: false, lastValueVisible: false });
  chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });

  chart.subscribeCrosshairMove((p) => {
    const r = p && p.time ? rows.find((x) => x.date === p.time) : rows[rows.length - 1];
    renderOhlc(r);
  });
  new ResizeObserver(() => chart.applyOptions({ width: el.clientWidth })).observe(el);
}

function renderOhlc(r) {
  if (!r) { $("#ohlc").innerHTML = ""; return; }
  $("#ohlc").innerHTML =
    `${r.date}　始 ${fmt(r.open, 1)}　高 ${fmt(r.high, 1)}　安 ${fmt(r.low, 1)}　終 ${fmt(r.close, 1)} ` +
    `<span class="${cls(r.change)}">${sign(r.changePct, 2, "%")}</span>　` +
    `<span style="color:${C("--ma5")}">MA5 ${fmt(r.ma5, 1)}</span>　<span style="color:${C("--ma25")}">MA25 ${fmt(r.ma25, 1)}</span>`;
}

async function loadStock(code, name) {
  current = { code, name };
  renderStockList();
  $("#stockCode").textContent = code;
  $("#stockName").textContent = name || "";
  $("#chartLoading").classList.add("on");
  try {
    const d = await api(`/api/stock/${encodeURIComponent(code)}?period=${period}`);
    if (current.code !== code) return;
    rows = d.rows;
    renderSummary(d.summary, name);
    candle.setData(rows.map((r) => ({ time: r.date, open: r.open, high: r.high, low: r.low, close: r.close })));
    ma5.setData(rows.filter((r) => r.ma5 != null).map((r) => ({ time: r.date, value: r.ma5 })));
    ma25.setData(rows.filter((r) => r.ma25 != null).map((r) => ({ time: r.date, value: r.ma25 })));
    vol.setData(rows.map((r) => ({
      time: r.date, value: r.volume ?? 0,
      color: r.close >= r.open ? "rgba(239,83,80,.35)" : "rgba(61,139,253,.35)",
    })));
    chart.timeScale().fitContent();
    renderOhlc(rows[rows.length - 1]);
    renderTable();
  } catch (err) {
    $("#stockSector").textContent = "エラー: " + err.message;
  } finally {
    $("#chartLoading").classList.remove("on");
  }
}

function renderSummary(s, name) {
  if (!name && s.longName) $("#stockName").textContent = s.longName;
  $("#stockSector").textContent = [s.sector, s.industry].filter(Boolean).join(" / ") || "—";
  $("#stockPrice").textContent = fmt(s.close, 1);
  $("#stockChange").innerHTML = `<span class="${cls(s.change)}">${sign(s.change, 1)}　(${sign(s.changePct, 2, "%")})</span>`;
  $("#stockAsOf").textContent = s.lastDate + " 終値";
  const k = [
    ["始値", fmt(s.open, 1)], ["高値", fmt(s.high, 1)], ["安値", fmt(s.low, 1)],
    ["出来高", big(s.volume)], ["売買代金(概算)", big(s.turnover)],
    ["MA5", fmt(s.ma5, 1)], ["MA25", fmt(s.ma25, 1)],
    ["52週高値", fmt(s.high52, 1)], ["52週安値", fmt(s.low52, 1)],
    ["時価総額", big(s.marketCap)], ["PER", s.per != null ? fmt(s.per, 1) + "倍" : "—"],
    ["PBR", s.pbr != null ? fmt(s.pbr, 2) + "倍" : "—"],
    ["配当利回り", s.dividendYield != null ? fmt(s.dividendYield, 2) + "%" : "—"],
    ["EPS", fmt(s.eps, 1)], ["ROE", s.roe != null ? fmt(s.roe, 1) + "%" : "—"],
    ["平均出来高", big(s.avgVolume)],
  ];
  $("#kpis").innerHTML = k.map(([l, v]) => `<div class="kpi"><div class="kpi-label">${l}</div><div class="kpi-value">${v}</div></div>`).join("");
}

// ===== 機能1: テーブル =====
const COLS = [
  { k: "date", l: "日付", f: (v) => v },
  { k: "open", l: "始値", f: (v) => fmt(v, 1) },
  { k: "high", l: "高値", f: (v) => fmt(v, 1) },
  { k: "low", l: "安値", f: (v) => fmt(v, 1) },
  { k: "close", l: "終値", f: (v) => fmt(v, 1) },
  { k: "change", l: "前日比", f: (v) => sign(v, 1), c: cls },
  { k: "changePct", l: "前日比%", f: (v) => sign(v, 2, "%"), c: cls },
  { k: "volume", l: "出来高", f: (v) => fmt(v) },
  { k: "volChangePct", l: "出来高前日比", f: (v) => sign(v, 1, "%"), c: cls },
  { k: "turnover", l: "売買代金(概算)", f: big },
  { k: "range", l: "値幅", f: (v) => fmt(v, 1) },
  { k: "rangePct", l: "値幅%", f: (v) => fmt(v, 2) + "%" },
  { k: "ma5", l: "MA5", f: (v) => fmt(v, 1) },
  { k: "ma25", l: "MA25", f: (v) => fmt(v, 1) },
  { k: "dev5", l: "MA5乖離", f: (v) => sign(v, 2, "%"), c: cls },
  { k: "dev25", l: "MA25乖離", f: (v) => sign(v, 2, "%"), c: cls },
  { k: "gap", l: "窓(始値-前日終値)", f: (v) => sign(v, 1), c: cls, extra: true },
  { k: "prevClose", l: "前日終値", f: (v) => fmt(v, 1), extra: true },
  { k: "adjClose", l: "調整後終値", f: (v) => fmt(v, 1), extra: true },
  { k: "ma75", l: "MA75", f: (v) => fmt(v, 1), extra: true },
  { k: "dividend", l: "配当", f: (v) => (v ? fmt(v, 2) : ""), extra: true },
  { k: "split", l: "分割", f: (v) => (v ? v : ""), extra: true },
];
let sortKey = "date", sortDir = -1;

function visibleCols() {
  return $("#showAll").checked ? COLS : COLS.filter((c) => !c.extra);
}

function renderTable() {
  const cols = visibleCols();
  const sorted = [...rows].sort((a, b) => {
    const x = a[sortKey], y = b[sortKey];
    if (x == null) return 1;
    if (y == null) return -1;
    return (x > y ? 1 : x < y ? -1 : 0) * sortDir;
  });
  // 期間内の最高値・最安値をハイライト
  const maxH = Math.max(...rows.map((r) => r.high ?? -Infinity));
  const minL = Math.min(...rows.map((r) => r.low ?? Infinity));
  $("#rowCount").textContent = `${rows.length}営業日`;
  $("#dataTable thead").innerHTML = "<tr>" + cols.map((c) =>
    `<th data-k="${c.k}" class="${c.k === sortKey ? "sorted" : ""}">${c.l}${c.k === sortKey ? (sortDir > 0 ? " ▲" : " ▼") : ""}</th>`).join("") + "</tr>";
  $("#dataTable tbody").innerHTML = sorted.map((r) => "<tr>" + cols.map((c) => {
    let k = c.c ? c.c(r[c.k]) : "";
    if (c.k === "high" && r.high === maxH) k = "hi";
    if (c.k === "low" && r.low === minL) k = "lo";
    return `<td class="${k}">${c.f(r[c.k])}</td>`;
  }).join("") + "</tr>").join("");
}

$("#dataTable").addEventListener("click", (e) => {
  const th = e.target.closest("th");
  if (!th) return;
  if (sortKey === th.dataset.k) sortDir *= -1;
  else { sortKey = th.dataset.k; sortDir = -1; }
  renderTable();
});
$("#showAll").addEventListener("change", renderTable);

$("#csvBtn").addEventListener("click", () => {
  if (!rows.length) return;
  const header = COLS.map((c) => c.l).join(",");
  const body = [...rows].reverse().map((r) => COLS.map((c) => r[c.k] ?? "").join(",")).join("\n");
  const blob = new Blob(["﻿" + header + "\n" + body], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${current.code}_${period}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
});

$("#periodSeg").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  period = b.dataset.p;
  document.querySelectorAll("#periodSeg button").forEach((x) => x.classList.toggle("on", x === b));
  if (current) loadStock(current.code, current.name);
});

// ===== 機能2: マーケット =====
function heatColor(p) {
  if (p == null) return "#2a2f38";
  const t = Math.min(Math.abs(p) / 3, 1);
  const from = [42, 47, 56];
  const to = p >= 0 ? [217, 66, 63] : [29, 95, 209];
  const c = from.map((f, i) => Math.round(f + (to[i] - f) * t));
  return `rgb(${c.join(",")})`;
}

async function loadMarket() {
  loadFx();
  const hm = $("#heatmap");
  hm.innerHTML = `<div class="loading show">225銘柄を取得中…（初回は10〜30秒ほどかかります）</div>`;
  $("#sectorBars").innerHTML = "";
  try {
    const d = await api("/api/heatmap");
    $("#heatDate").textContent = `${d.date}（前営業日 ${d.prevDate} 比）` +
      (d.provisional ? "　※暫定値: Yahooの日足が未確定のため5分足の最終値で計算" : "");
    $("#n225Price").textContent = fmt(d.nikkei.close, 2);
    $("#n225Change").innerHTML = `<span class="${cls(d.nikkei.changePct)}">${sign(d.nikkei.changePct, 2, "%")}</span>　<span class="muted">${d.date}</span>`;

    const sectors = [...d.sectors].sort((a, b) => (b.changePct ?? -99) - (a.changePct ?? -99));
    const maxAbs = Math.max(1, ...sectors.map((s) => Math.abs(s.changePct ?? 0)));
    $("#sectorBars").innerHTML = sectors.map((s) => {
      const w = (Math.abs(s.changePct ?? 0) / maxAbs) * 50;
      const pos = (s.changePct ?? 0) >= 0;
      return `<div class="sb" data-sector="${esc(s.sector)}">
        <span class="sb-name">${esc(s.sector)}</span>
        <span class="sb-track"><span class="sb-fill" style="${pos ? "left:50%" : `left:${50 - w}%`};width:${w}%;background:${pos ? C("--up") : C("--down")}"></span></span>
        <span class="sb-val ${cls(s.changePct)}">${sign(s.changePct, 2, "%")}</span></div>`;
    }).join("");

    // 売買代金上位はセルを大きくする
    const turnovers = d.sectors.flatMap((s) => s.stocks.map((x) => x.turnover || 0)).sort((a, b) => b - a);
    const bigLine = turnovers[Math.floor(turnovers.length * 0.12)] || Infinity;
    hm.innerHTML = sectors.map((s) => `
      <div class="hm-sector" id="sec-${esc(s.sector)}">
        <div class="hm-head"><b>${esc(s.sector)}</b><span class="mono ${cls(s.changePct)}">${sign(s.changePct, 2, "%")}</span></div>
        <div class="hm-cells">${s.stocks.map((x) => `
          <div class="hm-cell ${(x.turnover || 0) >= bigLine ? "big" : ""}" style="background:${heatColor(x.changePct)}"
               data-code="${esc(x.code)}" data-name="${esc(x.name)}" data-company="${esc(x.company)}"
               data-close="${x.close ?? ""}" data-pct="${x.changePct ?? ""}" data-turnover="${x.turnover ?? ""}">
            <div class="n">${esc(x.name)}</div><div class="v">${sign(x.changePct, 2, "%")}</div>
          </div>`).join("")}
        </div>
      </div>`).join("");
  } catch (err) {
    hm.innerHTML = `<div class="empty">ヒートマップを取得できませんでした: ${esc(err.message)}</div>`;
  }
}

$("#sectorBars").addEventListener("click", (e) => {
  const sb = e.target.closest(".sb");
  if (!sb) return;
  const el = document.getElementById("sec-" + sb.dataset.sector);
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.classList.add("flash");
  setTimeout(() => el.classList.remove("flash"), 1200);
});

const tip = $("#tooltip");
$("#heatmap").addEventListener("mousemove", (e) => {
  const c = e.target.closest(".hm-cell");
  if (!c) { tip.style.display = "none"; return; }
  const pct = c.dataset.pct === "" ? null : +c.dataset.pct;
  tip.innerHTML = `<b>${esc(c.dataset.code)} ${esc(c.dataset.company)}</b><br>
    終値 <span class="mono">${fmt(+c.dataset.close, 1)}</span>　<span class="mono ${cls(pct)}">${sign(pct, 2, "%")}</span><br>
    売買代金 <span class="mono">${big(+c.dataset.turnover)}</span><br><span class="muted">クリックでチャート表示</span>`;
  tip.style.display = "block";
  const x = Math.min(e.clientX + 14, innerWidth - tip.offsetWidth - 8);
  const y = Math.min(e.clientY + 14, innerHeight - tip.offsetHeight - 8);
  tip.style.left = x + "px";
  tip.style.top = y + "px";
});
$("#heatmap").addEventListener("mouseleave", () => (tip.style.display = "none"));
$("#heatmap").addEventListener("click", (e) => {
  const c = e.target.closest(".hm-cell");
  if (!c) return;
  tip.style.display = "none";
  showView("chart");
  loadStock(c.dataset.code, c.dataset.name);
});

async function loadFx() {
  try {
    const list = await api("/api/fx");
    $("#fxGrid").innerHTML = list.map((f, i) => `
      <div class="card fx-card">
        <div class="fx-top"><span class="fx-sym">${f.symbol}</span><span class="fx-label">${f.label}</span></div>
        <div class="fx-rate">${fmt(f.rate, f.symbol === "EUR/USD" ? 4 : 2)}</div>
        <div class="fx-top">
          <span class="fx-chg ${cls(f.change)}">${sign(f.change, f.symbol === "EUR/USD" ? 4 : 2)} (${sign(f.changePct, 2, "%")})</span>
          <span class="fx-time">${f.time}</span>
        </div>
        <div class="fx-spark" id="spark${i}"></div>
      </div>`).join("");
    list.forEach((f, i) => {
      const el = document.getElementById("spark" + i);
      const c = LightweightCharts.createChart(el, {
        width: el.clientWidth, height: 50,
        layout: { background: { color: "transparent" }, textColor: "transparent", attributionLogo: false },
        grid: { vertLines: { visible: false }, horzLines: { visible: false } },
        rightPriceScale: { visible: false }, timeScale: { visible: false },
        crosshair: { vertLine: { visible: false }, horzLine: { visible: false } },
        handleScroll: false, handleScale: false,
      });
      const up = f.history.length > 1 && f.history.at(-1).value >= f.history[0].value;
      const col = up ? C("--up") : C("--down");
      c.addAreaSeries({ lineColor: col, topColor: col + "44", bottomColor: col + "00", lineWidth: 1.5, priceLineVisible: false, lastValueVisible: false })
        .setData(f.history.filter((h) => h.value != null));
      c.timeScale().fitContent();
      new ResizeObserver(() => c.applyOptions({ width: el.clientWidth })).observe(el);
    });
  } catch (err) {
    $("#fxGrid").innerHTML = `<div class="empty">為替レートを取得できませんでした: ${esc(err.message)}</div>`;
  }
}

// ===== 機能3: ニュース =====
let news = [];
let newsSource = "すべて";

async function loadNews() {
  $("#newsList").innerHTML = `<div class="loading show">ニュースを取得中…</div>`;
  try {
    news = await api("/api/news");
  } catch (err) {
    $("#newsList").innerHTML = `<div class="empty">ニュースを取得できませんでした: ${esc(err.message)}</div>`;
    return;
  }
  const sources = ["すべて", ...new Set(news.map((n) => n.source))];
  $("#newsSources").innerHTML = sources.map((s) => `<button class="chip ${s === newsSource ? "on" : ""}" data-s="${esc(s)}">${esc(s)}</button>`).join("");
  renderNews();
}

function timeAgo(ts) {
  if (!ts) return "";
  const m = Math.floor((Date.now() / 1000 - ts) / 60);
  if (m < 60) return `${Math.max(m, 0)}分前`;
  if (m < 1440) return `${Math.floor(m / 60)}時間前`;
  return new Date(ts * 1000).toLocaleDateString("ja-JP", { month: "numeric", day: "numeric" });
}

function renderNews() {
  const q = $("#newsSearch").value.trim().toLowerCase();
  const list = news.filter((n) =>
    (newsSource === "すべて" || n.source === newsSource) &&
    (!q || (n.title + n.description).toLowerCase().includes(q)));
  $("#newsList").innerHTML = list.length ? list.map((n) => `
    <a class="news" href="${esc(n.link)}" target="_blank" rel="noopener">
      <div class="news-meta"><span class="news-src">${esc(n.source)}</span><span class="news-time">${timeAgo(n.ts)}</span></div>
      <div class="news-title">${esc(n.title)}</div>
      ${n.description ? `<div class="news-desc">${esc(n.description)}</div>` : ""}
    </a>`).join("") : `<div class="empty">該当するニュースはありません</div>`;
}

$("#newsSources").addEventListener("click", (e) => {
  const b = e.target.closest(".chip");
  if (!b) return;
  newsSource = b.dataset.s;
  document.querySelectorAll("#newsSources .chip").forEach((x) => x.classList.toggle("on", x === b));
  renderNews();
});
$("#newsSearch").addEventListener("input", renderNews);

// ===== 起動 =====
initChart();
loadStocks().then(() => {
  if (stocks.length) loadStock(stocks[0].code, stocks[0].name);
});
