// Chart SVG, built as strings from numbers only (labels are escaped by the caller's symbols being tickers).
import { fmtPct, fmtPrice, nearNum, sessionChange, state, tokNum } from "@/lib/chain";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** Step-line of the prices this page has seen for a coin. */
export function sparkline(a) {
  const s = state.samples[a] || [];
  if (!s.length) return "";
  const W = 76, H = 24, lo = Math.min(...s.map((x) => x.p)), hi = Math.max(...s.map((x) => x.p));
  const y = (p) => (hi === lo ? H / 2 : H - 3 - ((p - lo) / (hi - lo)) * (H - 6));
  const n = s.length;
  let d = `M0,${y(s[0].p).toFixed(1)}`;
  s.forEach((x, k) => { if (k) d += `H${((k / n) * W).toFixed(1)}V${y(x.p).toFixed(1)}`; });
  d += `H${W}`;
  const ch = sessionChange(a);
  return `<svg class="spark ${ch == null ? "" : ch >= 0 ? "up" : "down"}" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="price while this page was open"><path d="${d}"/></svg>`;
}

/**
 * The bonding curve with the current price marked, and where a typed trade would move it.
 * Constant product: price = NEAR in curve / tokens in curve. As a function of the NEAR side n: n² / k.
 * `afterNear` is the curve's NEAR side (yocto) after the previewed trade, or null.
 */
export function curveChart(i, W, H, afterNear) {
  const V = nearNum(state.params.virtual_near), N = nearNum(i.amm_near), T = tokNum(i.amm_tokens);
  if (!(N > 0 && T > 0)) return null;
  const k = N * T, real = Math.max(0, N - V);
  const after = afterNear == null ? null : Math.max(0, nearNum(afterNear) - V);
  const xmax = Math.max(real * 2, V * 0.5, (after ?? 0) * 1.15);
  const price = (x) => (V + x) ** 2 / k;
  const ymax = price(xmax) * 1.08;
  const L = 10, R = 10, Tp = 22, B = 28;
  const sx = (x) => L + (x / xmax) * (W - L - R), sy = (p) => H - B - (p / ymax) * (H - Tp - B);
  const pts = (from, to, n = 48) => Array.from({ length: n + 1 }, (_, j) => { const x = from + ((to - from) * j) / n; return `${sx(x).toFixed(1)},${sy(price(x)).toFixed(1)}`; });
  const done = pts(0, real), rest = pts(real, xmax);
  const cx = sx(real), cy = sy(price(real));
  const leftSide = cx > W * 0.6;
  const grid = [0.25, 0.5, 0.75, 1].map((f) => `<line class="grid" x1="${L}" x2="${W - R}" y1="${sy((ymax / 1.08) * f).toFixed(1)}" y2="${sy((ymax / 1.08) * f).toFixed(1)}"/>`).join("");
  let prev = "";
  if (after != null && Math.abs(after - real) > 1e-9) {
    const ax = sx(after), ay = sy(price(after));
    const mv = price(after) / price(real) - 1;
    prev = `<line class="guide" x1="${ax.toFixed(1)}" x2="${ax.toFixed(1)}" y1="${ay.toFixed(1)}" y2="${H - B}"/>
      <circle class="after ${mv >= 0 ? "up" : "down"}" cx="${ax.toFixed(1)}" cy="${ay.toFixed(1)}" r="5"/>
      <text class="lbl ${mv >= 0 ? "up" : "down"}" x="${Math.min(W - R - 2, Math.max(L + 2, ax)).toFixed(1)}" y="${Math.max(12, ay - 10).toFixed(1)}" text-anchor="${ax > W * 0.6 ? "end" : "start"}">after this trade ${fmtPct(mv)}</text>`;
  }
  return {
    start: price(0),
    svg: `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Price curve of $${esc(i.symbol)} with the current price marked">
    ${grid}
    <line class="axis" x1="${L}" x2="${W - R}" y1="${H - B}" y2="${H - B}"/>
    <polygon class="area" points="${sx(0).toFixed(1)},${H - B} ${done.join(" ")} ${cx.toFixed(1)},${H - B}"/>
    <polyline class="rest" points="${rest.join(" ")}"/>
    <polyline class="done" points="${done.join(" ")}"/>
    <line class="guide" x1="${cx.toFixed(1)}" x2="${cx.toFixed(1)}" y1="${cy.toFixed(1)}" y2="${H - B}"/>
    ${prev}
    <circle class="pulse" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="6"/>
    <circle class="now" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="5"/>
    <text class="lbl strong" x="${(cx + (leftSide ? -12 : 12)).toFixed(1)}" y="${(cy + (leftSide ? -22 : 16)).toFixed(1)}" text-anchor="${leftSide ? "end" : "start"}">now ${fmtPrice(price(real))} / 1M</text>
    <text class="lbl" x="${(cx + (leftSide ? -12 : 12)).toFixed(1)}" y="${(cy + (leftSide ? -8 : 30)).toFixed(1)}" text-anchor="${leftSide ? "end" : "start"}">${real.toFixed(2)} Ⓝ paid in so far</text>
    <text class="lbl" x="${L}" y="${H - 8}">0 Ⓝ paid in</text>
    <text class="lbl" x="${W - R}" y="${H - 8}" text-anchor="end">${xmax.toFixed(1)} Ⓝ</text>
  </svg>`,
  };
}

/** Price steps seen since the page was opened. */
export function sessionChart(a, W, H) {
  const s = state.samples[a] || [];
  if (!s.length) return null;
  const since = new Date(state.opened).toLocaleTimeString();
  const now = Date.now(), t0 = state.opened, span = Math.max(1, now - t0);
  const lo = Math.min(...s.map((x) => x.p)), hi = Math.max(...s.map((x) => x.p));
  const pad = hi === lo ? hi * 0.02 || 1 : (hi - lo) * 0.15;
  const y0 = lo - pad, y1 = hi + pad;
  const L = 10, R = 10, Tp = 22, B = 28;
  const sx = (t) => L + (Math.max(0, t - t0) / span) * (W - L - R), sy = (p) => H - B - ((p - y0) / (y1 - y0)) * (H - Tp - B);
  let d = `M${sx(s[0].t).toFixed(1)},${sy(s[0].p).toFixed(1)}`;
  for (let k = 1; k < s.length; k++) d += `H${sx(s[k].t).toFixed(1)}V${sy(s[k].p).toFixed(1)}`;
  d += `H${sx(now).toFixed(1)}`;
  const last = s[s.length - 1], ch = sessionChange(a);
  const dir = ch == null ? "" : ch >= 0 ? "up" : "down";
  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Price while this page was open">
    <line class="grid" x1="${L}" x2="${W - R}" y1="${sy(hi).toFixed(1)}" y2="${sy(hi).toFixed(1)}"/>
    <line class="grid" x1="${L}" x2="${W - R}" y1="${sy(lo).toFixed(1)}" y2="${sy(lo).toFixed(1)}"/>
    <line class="axis" x1="${L}" x2="${W - R}" y1="${H - B}" y2="${H - B}"/>
    <path class="step ${dir}" d="${d}"/>
    <circle class="now ${dir}" cx="${sx(now).toFixed(1)}" cy="${sy(last.p).toFixed(1)}" r="5"/>
    <text class="lbl" x="${L}" y="${(sy(hi) - 6).toFixed(1)}">${hi === lo ? "" : "high "}${fmtPrice(hi)} / 1M</text>
    ${hi === lo ? "" : `<text class="lbl" x="${L}" y="${(sy(lo) + 14).toFixed(1)}">low ${fmtPrice(lo)} / 1M</text>`}
    <text class="lbl" x="${L}" y="${H - 8}">${esc(since)}</text>
    <text class="lbl" x="${W - R}" y="${H - 8}" text-anchor="end">now · ${s.length} price ${s.length === 1 ? "level" : "levels"} seen</text>
  </svg>`;
}
