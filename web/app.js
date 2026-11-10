// AutoCTO page: reads every coin straight from NEAR RPC. No backend.
// ?network=local   -> config.local.json (written by `cargo run -p autocto-demo`)
// ?network=testnet -> config.testnet.json (written by `cargo run -p autocto-demo --bin deploy`)
// ?rpc=...&launchpad=... override either.

const qs = new URLSearchParams(location.search);
const NETWORK = qs.get("network") || "local";
const GAS = 300_000_000_000_000n;
const YOCTO = 10n ** 24n;
const UNIT = 10n ** 18n;
const NS = 1_000_000_000n;
// Calls the relayer forwards, so a holder with no NEAR can still make them.
const GASLESS = ["lock", "unlock", "vote", "vote_sealed", "reveal_vote", "veto", "veto_tender", "back_tender", "claim_tender"];

let cfg = {};
let chainNow = 0n;
const state = {
  coins: [], info: {}, offers: {}, tenders: {}, history: {}, decisions: {}, account: {}, keys: {},
  params: null, codeHash: null, codeMode: null, brain: null, block: null,
  // the signed-in (or viewed) account: balances and locks per coin
  me: { acct: "", near: null, bal: {}, locks: {}, until: {}, registered: {} },
  storageMin: {},
  // price samples taken by this page while it is open: there is no price-history view
  samples: {}, opened: Date.now(),
  sel: null, mode: "buy", chart: "curve", quote: null,
};

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const short = (acct) => String(acct || "").split(".")[0];
const sym = (acct) => state.info[acct]?.symbol || short(acct).toUpperCase();
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); return true; } catch (_) { return false; } },
  del(k) { try { localStorage.removeItem(k); } catch (_) {} },
};

// ---------- formatting ----------
const compact = (n, d = 2) => Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: d }).format(n);
const tokNum = (u) => Number(BigInt(u || 0) / 10n ** 12n) / 1e6;
const nearNum = (y) => Number(BigInt(y || 0) / 10n ** 18n) / 1e6;
const fmtTokens = (u) => compact(Number(BigInt(u || 0) / UNIT));
const fmtNear = (y) => {
  const n = nearNum(y);
  return (Math.abs(n) >= 1e5 ? compact(n) : n.toLocaleString("en", { minimumFractionDigits: 3, maximumFractionDigits: 3 })) + " Ⓝ";
};
// A small positive number with 4 significant digits and no exponent.
const fmtSig = (n) => {
  if (!(n > 0) || !isFinite(n)) return "0";
  const d = Math.max(0, 3 - Math.floor(Math.log10(n)));
  return d > 20 ? n.toExponential(3) : n.toFixed(d);
};
// price_yocto is yoctoNEAR per whole token.
const priceNum = (i) => Number(BigInt(i.price_yocto)) / 1e24;
const fmtRate = (ppm) => (Number(ppm) / 1e6).toFixed(4);
const fmtBps = (b) => (b >= 0 ? "+" : "") + (b / 100).toFixed(1) + "%";
const fmtPct = (x) => (x >= 0 ? "+" : "") + (x * 100).toFixed(Math.abs(x) < 0.1 ? 2 : 1) + "%";
const ago = (ns) => {
  const s = Math.max(0, Number((chainNow - BigInt(ns)) / NS));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
};
const left = (ns) => {
  const s = Number((BigInt(ns) - chainNow) / NS);
  if (s <= 0) return "ended";
  if (s < 120) return `${s}s left`;
  if (s < 7200) return `${Math.floor(s / 60)}m ${s % 60}s left`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m left`;
};
// Relative times live in their own elements so a card's HTML stays the same between refreshes.
const agoTag = (ns) => `<time data-ago="${esc(ns)}">${ago(ns)}</time>`;
const leftTag = (ns) => `<span data-left="${esc(ns)}">${left(ns)}</span>`;
const statusName = (st) => (typeof st === "string" ? st : Object.keys(st || {})[0] || "?");

// Decimal text <-> integer units, exact.
function parseUnits(text, dec) {
  const s = String(text).trim().replace(/[,\s_]/g, "");
  if (!/^(\d+\.?\d*|\.\d+)$/.test(s)) return null;
  const [i, f = ""] = s.split(".");
  return BigInt(i || "0") * 10n ** BigInt(dec) + BigInt(f.slice(0, dec).padEnd(dec, "0") || "0");
}
function fmtUnits(v, dec) {
  const s = BigInt(v).toString().padStart(dec + 1, "0");
  const f = s.slice(-dec).replace(/0+$/, "");
  return f ? `${s.slice(0, -dec)}.${f}` : s.slice(0, -dec);
}

// ---------- rpc ----------
async function rpc(method, params) {
  const r = await fetch(cfg.rpc, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "page", method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(JSON.stringify(j.error));
  return j.result;
}
async function view(account, method, args = {}) {
  const res = await rpc("query", {
    request_type: "call_function", finality: "optimistic", account_id: account,
    method_name: method, args_base64: btoa(JSON.stringify(args)),
  });
  return JSON.parse(new TextDecoder().decode(new Uint8Array(res.result)));
}

// ---------- dom helpers ----------
// Write HTML only when it changed, so nothing flickers on the 3 s refresh.
function setHTML(el, html) {
  if (el._html === html) return false;
  el._html = html; el.innerHTML = html;
  return true;
}
// Keyed list update: a card is replaced only when its own HTML changed.
function patch(container, items, emptyHtml = "") {
  if (!items.length) {
    if (container._sig !== "empty:" + emptyHtml) { container.innerHTML = emptyHtml; container._sig = "empty:" + emptyHtml; }
    return;
  }
  if (container._sig !== "list") { container.innerHTML = ""; container._sig = "list"; }
  const old = new Map();
  for (const el of [...container.children]) old.set(el._key, el);
  let prev = null;
  for (const { key, html } of items) {
    let el = old.get(key);
    old.delete(key);
    if (!el || el._html !== html) {
      const t = document.createElement("template");
      t.innerHTML = html.trim();
      const fresh = t.content.firstElementChild;
      fresh._key = key; fresh._html = html;
      if (el) { fresh.classList.add("no-anim"); el.replaceWith(fresh); }
      el = fresh;
    }
    const want = prev ? prev.nextElementSibling : container.firstElementChild;
    if (want !== el) container.insertBefore(el, want);
    prev = el;
  }
  for (const el of old.values()) el.remove();
}
function tickClocks() {
  for (const el of document.querySelectorAll("[data-ago]")) el.textContent = ago(el.dataset.ago);
  for (const el of document.querySelectorAll("[data-left]")) el.textContent = left(el.dataset.left);
}

// ---------- load ----------
const actor = () => (cfg.dev_key ? $("actor").value : $("viewer").value.trim());

async function loadConfig() {
  try {
    const r = await fetch(`config.${NETWORK}.json`, { cache: "no-store" });
    if (r.ok) cfg = await r.json();
  } catch (_) {}
  if (qs.get("rpc")) cfg.rpc = qs.get("rpc");
  if (qs.get("launchpad")) cfg.launchpad = qs.get("launchpad");
  if (!cfg.rpc || !cfg.launchpad) {
    $("coins").innerHTML = `<p class="muted pad">No config for <b>${esc(NETWORK)}</b>. Run <code>cargo run -p autocto-demo</code> and open <code>?network=local</code>, or pass <code>?rpc=…&launchpad=…</code>.</p>`;
    $("net-badge").textContent = `${NETWORK} · no config`;
    throw new Error("no config");
  }
  $("net-badge").textContent = NETWORK;
  $("launchpad").textContent = cfg.launchpad;
  if (cfg.dev_key && cfg.accounts?.length) {
    $("actor-wrap").hidden = false;
    $("actor").innerHTML = cfg.accounts.map((a) => `<option>${esc(a)}</option>`).join("");
    const saved = store.get(`autocto:actor:${cfg.launchpad}`);
    if (saved && cfg.accounts.includes(saved)) $("actor").value = saved;
    $("gasless-wrap").hidden = !cfg.relayer;
  } else {
    // No dev key: actions open a near-cli command. An account can still be typed to see its balances.
    $("viewer-wrap").hidden = false;
    $("viewer").value = store.get(`autocto:viewer:${NETWORK}`) || "";
  }
  state.sel = store.get(`autocto:coin:${cfg.launchpad}`);
}

async function loadUser() {
  const who = actor();
  const me = { acct: who, near: null, bal: {}, locks: {}, until: {}, registered: {} };
  if (who) {
    await Promise.all([
      rpc("query", { request_type: "view_account", finality: "optimistic", account_id: who })
        .then((a) => { me.near = BigInt(a.amount); }).catch(() => {}),
      ...state.coins.map(async ({ account_id: a }) => {
        const [bal, locks, until, reg] = await Promise.all([
          view(a, "ft_balance_of", { account_id: who }).catch(() => "0"),
          view(a, "locks_of", { account_id: who }).catch(() => []),
          view(a, "locked_until", { account_id: who }).catch(() => 0),
          a === state.sel ? view(a, "storage_balance_of", { account_id: who }).then((x) => x !== null).catch(() => undefined) : undefined,
        ]);
        me.bal[a] = BigInt(bal); me.locks[a] = locks; me.until[a] = BigInt(until || 0); me.registered[a] = reg;
        // A first buy pays the account's token storage out of the attached NEAR.
        if (reg === false && state.storageMin[a] == null) {
          state.storageMin[a] = await view(a, "storage_balance_bounds").then((b) => BigInt(b.min)).catch(() => 0n);
        }
      }),
    ]);
  }
  state.me = me;
}

async function load() {
  const block = await rpc("block", { finality: "optimistic" });
  chainNow = BigInt(block.header.timestamp_nanosec);
  state.block = block.header.height;
  if (!state.params) {
    [state.params, state.codeHash, state.codeMode, state.brain] = await Promise.all([
      view(cfg.launchpad, "get_params"), view(cfg.launchpad, "coin_code_hash"), view(cfg.launchpad, "get_code_mode"),
      view(cfg.launchpad, "get_brain"),
    ]);
    renderRules();
    const min = BigInt(await view(cfg.launchpad, "min_launch_deposit"));
    $("launch-cost").textContent = `deposit ${fmtNear(min + YOCTO)}`;
  }
  state.coins = (await view(cfg.launchpad, "list_coins", { limit: 100 })).filter((c) => c.state === "Live");
  await Promise.all(state.coins.map(async ({ account_id: a }) => {
    const [info, offers, history, decisions, tenders, acct, keys] = await Promise.all([
      view(a, "coin_info"), view(a, "list_offers"), view(a, "history"), view(a, "list_decisions", { limit: 12 }),
      view(a, "list_tenders").catch(() => []),
      rpc("query", { request_type: "view_account", finality: "optimistic", account_id: a }).catch(() => null),
      rpc("query", { request_type: "view_access_key_list", finality: "optimistic", account_id: a }).catch(() => null),
    ]);
    Object.assign(state.info, { [a]: info });
    state.offers[a] = offers; state.history[a] = history; state.decisions[a] = decisions; state.tenders[a] = tenders;
    state.account[a] = acct; state.keys[a] = keys?.keys?.length ?? null;
  }));
  // Pick a coin for the trade panel: the saved one, else the first that still trades.
  const ids = state.coins.map((c) => c.account_id);
  if (!ids.includes(state.sel)) {
    state.sel = ids.find((a) => statusName(state.info[a].status) === "Active") || ids[0] || null;
  }
  await loadUser();
  // Sample prices for the session chart (only when the price moved).
  for (const a of ids) {
    const p = priceNum(state.info[a]);
    const s = (state.samples[a] ??= []);
    if (!s.length || s[s.length - 1].p !== p) s.push({ t: Date.now(), p });
    if (s.length > 400) s.splice(1, s.length - 400);
  }
}

let busy = false, again = false;
async function refresh() {
  if (busy) { again = true; return; }
  busy = true;
  try { await load(); render(); } finally {
    busy = false;
    if (again) { again = false; refresh().catch(() => {}); }
  }
}

// ---------- render: rules, ticker ----------
function renderRules() {
  const p = state.params;
  const items = [
    `vote ${p.vote_period_sec}s`, ...(p.reveal_period_sec > 0 ? [`sealed votes · reveal ${p.reveal_period_sec}s`] : []),
    `quorum ${p.quorum_bps / 100}%`, `approval ${p.approval_bps / 100}%`,
    `buyer veto ${p.veto_bps / 100}%`, `premium ≤ ${p.max_premium_bps / 100}%`, `discount ≤ ${p.max_discount_bps / 100}%`,
    `dilution ≤ ${p.max_dilution_bps / 100}%`, `newborn protection ${p.newborn_protection_sec}s`,
    `rebid cooldown ${p.rebid_cooldown_sec}s`, `${p.max_offers_per_day} bids/day`,
    `brain ${fmtNear(p.brain_fee)}/think, ≤ ${fmtNear(p.brain_daily_cap)}/day`, `fee ${p.trade_fee_bps / 100}%`,
    ...(p.tender_threshold_bps ? [`tender: ${p.tender_threshold_bps / 100}% of outside supply in ${p.tender_period_sec}s, backed by ${p.quorum_bps / 100}% of holders, mints ≤ ${p.tender_max_dilution_bps / 100}%`] : []),
  ];
  $("rules-chips").innerHTML = items.map((t) => `<span>${esc(t)}</span>`).join("") + `<span>no owner · no setters</span>`;
  $("code-hash").textContent = `coin code ${state.codeHash} · ${typeof state.codeMode === "string" ? state.codeMode : "Global"}`;
}

const curveReal = (i) => { const r = BigInt(i.amm_near) - BigInt(state.params.virtual_near); return r > 0n ? r : 0n; };
const marketCap = (i) => (BigInt(i.price_yocto) * BigInt(i.circulating)) / UNIT;
const isMerged = (i) => statusName(i.status) === "Merged";
const liveOffer = (o) => ["Open", "Executing", "Sending"].includes(statusName(o.status));

function renderTicker(offers) {
  let liq = 0n, tre = 0n, cap = 0n, trading = 0;
  for (const { account_id: a } of state.coins) {
    const i = state.info[a];
    tre += BigInt(i.treasury);
    if (isMerged(i)) continue;
    trading++; liq += curveReal(i); cap += marketCap(i);
  }
  const deals = offers.filter(liveOffer).length
    + Object.values(state.tenders).flat().filter((t) => ["Open", "Opening"].includes(statusName(t.status))).length;
  const cells = [
    ["coins trading", `${trading}<small> of ${state.coins.length}</small>`],
    ["market cap", esc(fmtNear(cap))],
    ["curve liquidity", esc(fmtNear(liq))],
    ["treasuries", esc(fmtNear(tre))],
    ["live deals", String(deals)],
    ["block", `#${esc(state.block)}`],
  ];
  setHTML($("ticker"), cells.map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join(""));
  $("nav-deals").hidden = !deals; $("nav-deals").textContent = deals;
}

// ---------- render: market ----------
function coinStatus(info) {
  const st = statusName(info.status);
  if (st === "Merged") return [`merged → $${esc(sym(info.status.Merged.into))}`, "merged"];
  if (st === "MergePending") return ["merge pending", "pending"];
  if (chainNow < BigInt(info.protected_until)) return [`newborn · ${leftTag(info.protected_until)}`, "newborn"];
  return ["open to bids", "active"];
}

function sameCode(a) {
  const acct = state.account[a];
  if (!acct) return null;
  const h = acct.global_contract_hash || acct.code_hash;
  return h === state.codeHash;
}

function badges(a) {
  const i = state.info[a];
  const same = sameCode(a);
  return `<span class="badge ${state.keys[a] === 0 ? "ok" : "bad"}" title="access keys on the coin account">${state.keys[a] === 0 ? "🔒 0 keys" : `${esc(state.keys[a] ?? "?")} keys`}</span>
    <span class="badge ${same ? "ok" : "bad"}" title="code hash equals the launchpad's coin code">${same ? "✔ launchpad code" : "code ?"}</span>
    ${i.absorbed.map(([t]) => `<span class="badge ate">ate $${esc(sym(t))}</span>`).join("")}
    ${(i.watchlist || []).map((t) => `<span class="badge" title="outside token nominated by holders for a tender">👀 ${esc(short(t))}</span>`).join("")}`;
}

const hue = (s) => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
const avatar = (i, cls = "") => `<span class="ava ${cls}" style="--h:${hue(i.symbol)}" aria-hidden="true">${esc(String(i.symbol).slice(0, 2))}</span>`;

function sessionChange(a) {
  const s = state.samples[a] || [];
  if (s.length < 2 || !(s[0].p > 0)) return null;
  return s[s.length - 1].p / s[0].p - 1;
}
function sparkline(a) {
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

const lastPrice = {};
function renderCoins() {
  const who = state.me.acct;
  patch($("coins"), state.coins.map(({ account_id: a }) => {
    const i = state.info[a];
    const [label, cls] = coinStatus(i);
    const merged = isMerged(i);
    const p = priceNum(i);
    const flash = lastPrice[a] != null && lastPrice[a] !== p ? (p > lastPrice[a] ? " flash-up" : " flash-down") : "";
    lastPrice[a] = p;
    const ch = sessionChange(a);
    const mine = (state.me.bal[a] || 0n) + (state.me.locks[a] || []).reduce((s, l) => s + BigInt(l.amount), 0n);
    const html = `<article class="row${a === state.sel ? " sel" : ""}${merged ? " dim" : ""}" data-select="${esc(a)}" data-scroll="1" tabindex="0" role="button" aria-label="Open $${esc(i.symbol)}">
      <div class="c-coin">${avatar(i)}
        <div class="who"><div class="nm"><b>$${esc(i.symbol)}</b> <span class="muted">${esc(i.name)}</span></div>
        <div class="badges">${badges(a)}</div></div></div>
      <div class="c num${flash}" data-l="Price">${merged ? "–" : `${fmtSig(p)} Ⓝ`}</div>
      <div class="c c-spark" data-l="Session">${merged ? "" : sparkline(a)}${ch == null || merged ? "" : `<span class="chg ${ch >= 0 ? "up" : "down"}">${fmtPct(ch)}</span>`}</div>
      <div class="c num" data-l="Market cap">${merged ? "–" : esc(fmtNear(marketCap(i)))}</div>
      <div class="c num" data-l="Liquidity">${esc(fmtNear(curveReal(i)))}</div>
      <div class="c num" data-l="Treasury">${esc(fmtNear(i.treasury))}</div>
      <div class="c num" data-l="You hold">${who ? esc(fmtTokens(mine)) : "–"}</div>
      <div class="c c-status"><span class="pill ${cls}">${label}</span></div>
    </article>`;
    return { key: a, html };
  }), `<p class="muted pad">No coins yet. Launch the first one below.</p>`);

  setHTML($("coin-tabs"), state.coins.map(({ account_id: a }) =>
    `<button type="button" class="chip${a === state.sel ? " on" : ""}" data-select="${esc(a)}">$${esc(sym(a))}</button>`).join(""));
}

// ---------- render: coin detail, charts ----------
function renderDetail() {
  const a = state.sel, i = state.info[a];
  if (!i) return;
  const [label, cls] = coinStatus(i);
  const merged = isMerged(i);
  const ch = sessionChange(a);
  setHTML($("coin-head"), `<div class="ch-main">${avatar(i, "big")}
      <div class="ch-name"><h3>$${esc(i.symbol)} <span class="muted">${esc(i.name)}</span></h3>
        <div class="acct mono">${esc(a)}</div></div>
      <div class="ch-price"><div class="bigprice mono">${merged ? "merged" : `${fmtSig(priceNum(i))} Ⓝ`}</div>
        <div class="small">${ch == null || merged ? `<span class="muted">per token</span>` : `<span class="chg ${ch >= 0 ? "up" : "down"}">${fmtPct(ch)}</span> <span class="muted">since you opened this page</span>`}</div></div>
    </div>
    <p class="persona">${esc(i.persona)}</p>
    <div class="badges"><span class="pill ${cls}">${label}</span>${badges(a)}</div>`);
  // price_yocto is per whole token; NEAR per 1M tokens is easier to read.
  const perM = Number(BigInt(i.price_yocto) * 1_000_000n * 1_000_000n / YOCTO) / 1e6;
  const rows = [
    ["price / 1M", `${perM.toFixed(4)} Ⓝ`], ["market cap", merged ? "–" : fmtNear(marketCap(i))],
    ["circulating", fmtTokens(i.circulating)], ["locked", fmtTokens(i.total_locked)],
    ["total supply", fmtTokens(i.total_supply)],
    ...(BigInt(i.owed || 0) > 0n ? [["owed to converters", fmtTokens(i.owed), "still to be minted for holders of coins it absorbed"]] : []),
    ["curve NEAR", fmtNear(curveReal(i))], ["treasury", fmtNear(i.treasury)],
    ["brain spent", fmtNear(i.brain_spent_total)], ["decisions", String(i.decisions)],
  ];
  setHTML($("coin-stats"), rows.map(([k, v, tip]) => `<div${tip ? ` title="${esc(tip)}"` : ""}><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("")
    + `<div><dt>born</dt><dd>${agoTag(i.born_at)}</dd></div>`);
  renderChart();
}

// Where the curve would sit after the trade typed into the ticket (same math as the contract).
function previewNear(i) {
  const q = state.quote;
  if (!q || q.coin !== state.sel || q.mode !== state.mode) return null;
  const N = BigInt(i.amm_near), T = BigInt(i.amm_tokens), fee = BigInt(state.params.trade_fee_bps);
  if (q.mode === "buy") return N + q.eff - (q.eff * fee) / 10000n;
  if (q.mode === "sell") return N - (N * q.amount) / (T + q.amount);
  return null;
}

function renderChart() {
  const a = state.sel, i = state.info[a], box = $("chart");
  if (!i) return;
  const W = Math.max(280, Math.round(box.clientWidth || 600)), H = W < 480 ? 210 : 260;
  if (state.chart === "session") return renderSessionChart(a, W, H);
  if (isMerged(i)) {
    $("chart-note").textContent = "";
    setHTML(box, `<p class="muted pad">$${esc(i.symbol)} merged into $${esc(sym(i.status.Merged.into))}: its curve NEAR and treasury moved over, so there is no curve left to trade on. Holders convert at ${fmtRate(i.status.Merged.rate_ppm)} $${esc(sym(i.status.Merged.into))} per $${esc(i.symbol)}.</p>`);
    return;
  }
  // Constant product: price = NEAR in curve / tokens in curve. As a function of the NEAR side n: n² / k.
  const V = nearNum(state.params.virtual_near), N = nearNum(i.amm_near), T = tokNum(i.amm_tokens);
  if (!(N > 0 && T > 0)) { setHTML(box, `<p class="muted pad">The curve is empty.</p>`); return; }
  const k = N * T, real = Math.max(0, N - V);
  const pv = previewNear(i);
  const after = pv == null ? null : Math.max(0, nearNum(pv) - V);
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
  $("chart-note").textContent = `price = NEAR in curve ÷ tokens in curve · ${fmtNear(state.params.virtual_near)} virtual · starts at ${fmtSig(price(0))} Ⓝ`;
  setHTML(box, `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Bonding curve of $${esc(i.symbol)} with the current price marked">
    ${grid}
    <line class="axis" x1="${L}" x2="${W - R}" y1="${H - B}" y2="${H - B}"/>
    <polygon class="area" points="${sx(0).toFixed(1)},${H - B} ${done.join(" ")} ${cx.toFixed(1)},${H - B}"/>
    <polyline class="rest" points="${rest.join(" ")}"/>
    <polyline class="done" points="${done.join(" ")}"/>
    <line class="guide" x1="${cx.toFixed(1)}" x2="${cx.toFixed(1)}" y1="${cy.toFixed(1)}" y2="${H - B}"/>
    ${prev}
    <circle class="pulse" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="6"/>
    <circle class="now" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="5"/>
    <text class="lbl strong" x="${(cx + (leftSide ? -12 : 12)).toFixed(1)}" y="${(cy + (leftSide ? -22 : 16)).toFixed(1)}" text-anchor="${leftSide ? "end" : "start"}">now ${fmtSig(price(real))} Ⓝ</text>
    <text class="lbl" x="${(cx + (leftSide ? -12 : 12)).toFixed(1)}" y="${(cy + (leftSide ? -8 : 30)).toFixed(1)}" text-anchor="${leftSide ? "end" : "start"}">${real.toFixed(2)} Ⓝ in curve</text>
    <text class="lbl" x="${L}" y="${H - 8}">0 Ⓝ in curve</text>
    <text class="lbl" x="${W - R}" y="${H - 8}" text-anchor="end">${xmax.toFixed(1)} Ⓝ</text>
  </svg>`);
}

function renderSessionChart(a, W, H) {
  const s = state.samples[a] || [], box = $("chart");
  const since = new Date(state.opened).toLocaleTimeString();
  $("chart-note").textContent = `sampled by this page since ${since} · the chain keeps no price history`;
  if (!s.length) { setHTML(box, `<p class="muted pad">Collecting…</p>`); return; }
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
  setHTML(box, `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Price of $${esc(sym(a))} while this page was open">
    <line class="grid" x1="${L}" x2="${W - R}" y1="${sy(hi).toFixed(1)}" y2="${sy(hi).toFixed(1)}"/>
    <line class="grid" x1="${L}" x2="${W - R}" y1="${sy(lo).toFixed(1)}" y2="${sy(lo).toFixed(1)}"/>
    <line class="axis" x1="${L}" x2="${W - R}" y1="${H - B}" y2="${H - B}"/>
    <path class="step ${dir}" d="${d}"/>
    <circle class="now ${dir}" cx="${sx(now).toFixed(1)}" cy="${sy(last.p).toFixed(1)}" r="5"/>
    <text class="lbl" x="${L}" y="${(sy(hi) - 6).toFixed(1)}">${hi === lo ? "" : "high "}${fmtSig(hi)} Ⓝ</text>
    ${hi === lo ? "" : `<text class="lbl" x="${L}" y="${(sy(lo) + 14).toFixed(1)}">low ${fmtSig(lo)} Ⓝ</text>`}
    <text class="lbl" x="${L}" y="${H - 8}">${esc(since)}</text>
    <text class="lbl" x="${W - R}" y="${H - 8}" text-anchor="end">now · ${s.length} price ${s.length === 1 ? "level" : "levels"} seen</text>
  </svg>`);
}

// ---------- render: trade ticket ----------
// The ticket's inputs are static HTML: refreshes only touch the text around them.
const lockedOf = (a) => (state.me.locks[a] || []).reduce((s, l) => s + BigInt(l.amount), 0n);
function available(mode, a) {
  if (!state.me.acct) return null;
  if (mode === "buy") return state.me.near;
  if (mode === "unlock") return lockedOf(a);
  return state.me.bal[a] ?? null;
}
const modeDec = (mode) => (mode === "buy" ? 24 : 18);

function renderTicket() {
  const a = state.sel, i = state.info[a];
  if (!i) return;
  const merged = isMerged(i), mode = state.mode, s = i.symbol;
  $("ticket-live").hidden = merged; $("ticket-merged").hidden = !merged;
  $("mode-seg").hidden = merged;
  $("think").hidden = merged; $("think-note").hidden = merged;
  if (merged) {
    const into = i.status.Merged.into;
    $("merged-note").textContent = `$${s} merged into $${sym(into)} at ${fmtRate(i.status.Merged.rate_ppm)} $${sym(into)} per $${s}. Convert swaps everything you hold here, wallet and locked, for $${sym(into)}.`;
    $("convert").dataset.coin = a;
    $("convert").textContent = `Convert to $${sym(into)}`;
  }
  for (const b of $("mode-seg").children) b.classList.toggle("on", b.dataset.mode === mode);
  $("amt-label").textContent = { buy: "You pay", sell: "You sell", lock: "You lock", unlock: "You unlock" }[mode];
  $("amt-unit").textContent = mode === "buy" ? "NEAR" : `$${s}`;
  const av = available(mode, a);
  $("avail").textContent = av == null ? "–" : mode === "buy" ? fmtNear(av) : fmtTokens(av);
  setHTML($("quick"), mode === "buy"
    ? ["0.1", "1", "5", "10"].map((v) => `<button type="button" class="chip" data-amt="${v}">${v} Ⓝ</button>`).join("")
    : [25, 50, 75, 100].map((v) => `<button type="button" class="chip" data-pct="${v}">${v === 100 ? "Max" : v + "%"}</button>`).join(""));
  $("slip-wrap").hidden = mode === "lock" || mode === "unlock";
  const sub = $("submit");
  sub.dataset.act = mode; sub.dataset.coin = a;
  sub.className = `big ${mode}`;
  sub.textContent = `${{ buy: "Buy", sell: "Sell", lock: "Lock", unlock: "Unlock" }[mode]} $${s}`;
  $("think").dataset.coin = a;
  $("think-note").textContent = `wakes the brain · ${fmtNear(state.params.brain_fee)} per think · spent today ${fmtNear(i.brain_spent_today)} of ${fmtNear(state.params.brain_daily_cap)}`;

  // position
  const who = state.me.acct;
  $("pos-who").textContent = who || "";
  const until = state.me.until[a] || 0n;
  setHTML($("pos"), !who
    ? `<div><dt class="muted">${cfg.dev_key ? "No account selected." : "Type your account next to “view as” to see balances."}</dt></div>`
    : `<div><dt>wallet $${esc(s)}</dt><dd>${esc(fmtTokens(state.me.bal[a] || 0n))}</dd></div>
       <div><dt>locked $${esc(s)}</dt><dd>${esc(fmtTokens(lockedOf(a)))}</dd></div>
       <div><dt>NEAR</dt><dd>${state.me.near == null ? "–" : esc(fmtNear(state.me.near))}</dd></div>
       ${until > chainNow ? `<div><dt>backing a vote</dt><dd>${leftTag(until)}</dd></div>` : ""}`);
  const lots = state.me.locks[a] || [];
  setHTML($("lots"), lots.length
    ? `<div class="small muted">Locked lots · only lots locked before a bid was announced count in its vote</div>`
      + lots.map((l) => `<div class="lot"><span class="mono">${esc(fmtTokens(l.amount))} $${esc(s)}</span><span class="muted small">locked ${agoTag(l.since)}</span></div>`).join("")
    : who ? `<div class="small muted">No locked lots. Lock tokens to vote on bids for $${esc(s)} and to veto its own bids.</div>` : "");
  updateQuote();
}

// Live quote straight from the coin's views. `eff` is the NEAR that reaches the curve.
async function fetchQuote(mode, a, amount) {
  if (mode === "buy") {
    const eff = state.me.registered[a] === false ? amount - (state.storageMin[a] || 0n) : amount;
    if (eff <= 0n) throw new Error("too small: a first buy also pays for token storage");
    return { mode, coin: a, amount, eff, out: BigInt(await view(a, "quote_buy", { near: eff.toString() })) };
  }
  return { mode, coin: a, amount, eff: 0n, out: BigInt(await view(a, "quote_sell", { tokens: amount.toString() })) };
}
const slipBps = () => BigInt($("slip").value);
const minOut = (out) => (out * (10000n - slipBps())) / 10000n;

let quoteSeq = 0;
async function updateQuote() {
  const seq = ++quoteSeq;
  const a = state.sel, mode = state.mode, i = state.info[a];
  if (!i || isMerged(i)) return;
  const raw = $("amt").value, v = parseUnits(raw, modeDec(mode)), av = available(mode, a);
  const until = state.me.until[a] || 0n;
  const hints = {
    buy: `NEAR goes into the curve; ${state.params.trade_fee_bps / 100}% fee goes to the coin's treasury.`,
    sell: "Sells back to the curve. Locked tokens must be unlocked first.",
    lock: "Locked tokens vote on takeover bids. Lock before a bid is announced: later lots do not count for it.",
    unlock: "Newest lots are released first.",
  };
  let note = hints[mode], ok = false, rows = "", quote = null, bad = false;
  if (raw.trim() === "") { /* keep the hint */ }
  else if (v == null || v === 0n) { note = "Enter a positive amount."; bad = true; }
  else if (av != null && v > av) { note = `More than the ${mode === "buy" ? fmtNear(av) : fmtTokens(av) + " $" + i.symbol} available.`; bad = true; }
  else if (mode === "unlock" && until > chainNow) { note = "These tokens back a vote that has not ended yet."; bad = true; }
  else if (mode === "lock" || mode === "unlock") ok = true;
  else {
    try { quote = await fetchQuote(mode, a, v); } catch (e) { note = `No quote: ${String(e.message || e).slice(0, 120)}`; bad = true; }
    if (seq !== quoteSeq) return;
    if (quote) {
      ok = quote.out > 0n;
      const spot = priceNum(i);
      const nearSide = mode === "buy" ? nearNum(v) : nearNum(quote.out);
      const tokSide = mode === "buy" ? tokNum(quote.out) : tokNum(v);
      const avg = tokSide > 0 ? nearSide / tokSide : 0;
      const impact = spot > 0 && avg > 0 ? (mode === "buy" ? avg / spot - 1 : 1 - avg / spot) : 0;
      const recv = (x) => (mode === "buy" ? `${fmtTokens(x)} $${esc(i.symbol)}` : esc(fmtNear(x)));
      rows = `<div class="recv"><dt>You receive</dt><dd>≈ ${recv(quote.out)}</dd></div>
        <div><dt>Average price</dt><dd>${fmtSig(avg)} Ⓝ</dd></div>
        <div><dt title="How far the average price is from the current price, fee included">Price impact + fee</dt><dd class="${impact > 0.05 ? "down" : ""}">${(impact * 100).toFixed(2)}%</dd></div>
        <div><dt title="The trade is refused by the contract if you would get less">Minimum received</dt><dd>${recv(minOut(quote.out))}</dd></div>`;
      if (mode === "buy" && state.me.registered[a] === false) note = `First buy of $${i.symbol}: ${fmtNear(state.storageMin[a] || 0n)} of this pays for your token storage.`;
      if (!ok) { note = "Too small to trade."; bad = true; }
    }
  }
  state.quote = quote;
  setHTML($("quote"), rows);
  $("submit").disabled = !ok || acting;
  $("ticket-note").textContent = note;
  $("ticket-note").classList.toggle("bad", bad);
  renderChart();
}

// ---------- render: deals ----------
function allOffers() {
  // The target's copy carries the vote; the buyer's copy carries the veto.
  const byKey = new Map();
  for (const [coin, list] of Object.entries(state.offers)) {
    for (const o of list) {
      const key = `${o.buyer}#${o.id}`;
      const cur = byKey.get(key) || {};
      if (o.target === coin) byKey.set(key, { ...cur, ...o, veto: cur.veto ?? o.veto, buyerStatus: cur.buyerStatus });
      else byKey.set(key, { ...o, ...cur, veto: o.veto, buyerStatus: o.status, target_market: cur.target_market || o.target_market });
    }
  }
  return [...byKey.values()].sort((a, b) => (liveOffer(b) - liveOffer(a)) || Number(BigInt(b.created_at) - BigInt(a.created_at)));
}

function stanceFor(o) {
  const h = state.history[o.target] || [];
  const s = [...h].reverse().find((e) => e.event === "stance" && e.text.includes(`${o.buyer}#${o.id}`));
  return s ? s.text : null;
}

// Sealed ballots: the salt and the choice stay in this browser until the reveal.
const memBallots = new Map();
const ballotKey = (offer, round, acct) => `autocto:ballot:${cfg.launchpad}:${offer}|${round}|${acct}`;
function getBallot(offer, round, acct) {
  const k = ballotKey(offer, round, acct);
  if (memBallots.has(k)) return memBallots.get(k);
  try { const b = JSON.parse(store.get(k)); return b && typeof b.salt === "string" ? b : null; } catch (_) { return null; }
}
function putBallot(offer, round, acct, b) {
  const k = ballotKey(offer, round, acct);
  memBallots.set(k, b);
  return store.set(k, JSON.stringify(b));
}
function dropBallot(offer, round, acct) {
  const k = ballotKey(offer, round, acct);
  memBallots.delete(k); store.del(k);
}
async function sha256Hex(text) {
  if (!globalThis.crypto?.subtle) throw new Error("sha256 needs a secure page (https or localhost)");
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const randomHex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, "0")).join("");

const proposerHtml = (pr) => (pr.Brain ? `🧠 brain decision #${esc(pr.Brain.decision_id)}` : `✋ ${esc(pr.Holder?.account_id)}`);

function renderOffers(offers) {
  const p = state.params;
  const sealedMode = p.reveal_period_sec > 0;
  const who = actor();
  patch($("offers"), offers.map((o) => {
    const st = statusName(o.status);
    const key = `${o.buyer}#${o.id}`;
    const circ = BigInt(o.target_market?.circulating || 1) || 1n;
    const yes = BigInt(o.yes), no = BigInt(o.no), sealed = BigInt(o.sealed || 0);
    const pct = (x) => Math.min(100, Number((x * 10000n) / circ) / 100);
    const quorum = p.quorum_bps / 100;
    const bcirc = BigInt(o.buyer_market?.circulating || 1) || 1n;
    const vetoPct = Math.min(100, Number((BigInt(o.veto || 0) * 10000n) / bcirc) / 100);
    const open = st === "Open";
    const ended = BigInt(o.vote_ends) <= chainNow;
    // With sealed votes, finalize waits for the reveal window too.
    const revealEnds = BigInt(o.vote_ends) + BigInt(p.reveal_period_sec || 0) * NS;
    const canFinalize = chainNow >= revealEnds;
    const inReveal = sealedMode && ended && !canFinalize;
    const ballot = sealedMode && who ? getBallot(key, o.round, who) : null;
    const cls = { Open: "active", Executing: "pending", Executed: "merged", Failed: "failed", Sending: "pending" }[st] || "";
    const stance = stanceFor(o);
    const B = sym(o.buyer), T = sym(o.target);
    const voteBtns = ballot
      ? `<span class="small muted">You sealed <b>${ballot.support ? "YES" : "NO"}</b>. Come back to reveal it when the vote ends.</span>`
      : `<button class="yes" data-act="vote" data-coin="${esc(o.target)}" data-offer="${esc(key)}" data-round="${esc(o.round)}" data-support="true">${sealedMode ? "Seal YES" : "Vote YES"}</button>
         <button class="no" data-act="vote" data-coin="${esc(o.target)}" data-offer="${esc(key)}" data-round="${esc(o.round)}" data-support="false">${sealedMode ? "Seal NO" : "Vote NO"}</button>`;
    const html = `<article class="card offer${open ? " live" : ""}">
      <div class="route"><span class="vs"><b>$${esc(B)}</b><i>bids for</i><b>$${esc(T)}</b></span>
        <span class="pill ${cls}">${esc(st === "Failed" ? "failed: " + o.status.Failed.reason : st.toLowerCase())}</span>
        <span class="muted small">${proposerHtml(o.proposer)} · ${agoTag(o.created_at)}</span></div>
      <div class="terms">
        <span><small>rate</small><b>${fmtRate(o.rate_ppm)}</b> $${esc(B)} per $${esc(T)}</span>
        <span><small>fair</small><b>${fmtRate(o.fair_rate_ppm)}</b></span>
        <span><small>premium</small><b class="${o.premium_bps >= 0 ? "up" : "down"}">${fmtBps(o.premium_bps)}</b></span>
        <span><small>round</small><b>${esc(o.round)}</b></span>
        ${open && !ended ? `<span><small>vote</small><b>${leftTag(o.vote_ends)}</b></span>` : ""}
        ${open && inReveal ? `<span><small>reveal window</small><b>${leftTag(revealEnds)}</b></span>` : ""}
      </div>
      <div class="pitch"><div class="who">pitch from $${esc(B)} · untrusted</div>“${esc(o.pitch)}”</div>
      ${o.counter ? `<div class="pitch"><div class="who">counter from $${esc(T)}: ${fmtRate(o.counter.rate_ppm)}</div>“${esc(o.counter.pitch)}”</div>` : ""}
      ${stance ? `<div class="pitch brain"><div class="who">$${esc(T)} brain</div>${esc(stance)}</div>` : ""}
      <div>
        <div class="barlabel"><span><b class="up">yes ${fmtTokens(yes)}</b> · <b class="down">no ${fmtTokens(no)}</b>${sealedMode || sealed > 0n ? ` · sealed ${fmtTokens(sealed)} <span title="Sealed votes count only once revealed">(direction hidden)</span>` : ""}</span><span>quorum ${quorum}% of ${fmtTokens(circ)}</span></div>
        <div class="bar"><div class="y" style="width:${pct(yes)}%"></div><div class="n" style="left:${pct(yes)}%;width:${pct(no)}%"></div><div class="s" style="left:${pct(yes + no)}%;width:${pct(sealed)}%"></div><div class="q" style="left:${quorum}%"></div></div>
      </div>
      <div>
        <div class="barlabel"><span>$${esc(B)} veto ${fmtTokens(o.veto || 0)}</span><span>blocks at ${p.veto_bps / 100}%</span></div>
        <div class="bar"><div class="n" style="left:0;width:${vetoPct}%"></div><div class="q" style="left:${p.veto_bps / 100}%"></div></div>
      </div>
      <div class="actions">
        ${open && !ended ? `${voteBtns}
          <button data-act="veto" data-coin="${esc(o.buyer)}" data-id="${esc(o.id)}">Veto (as $${esc(B)} holder)</button>` : ""}
        ${open && o.counter ? `<button data-act="accept_counter" data-coin="${esc(o.buyer)}" data-id="${esc(o.id)}">Accept counter</button>` : ""}
        ${open && inReveal ? (ballot
          ? `<button class="primary" data-act="reveal" data-coin="${esc(o.target)}" data-offer="${esc(key)}" data-round="${esc(o.round)}">Reveal my ${ballot.support ? "YES" : "NO"} vote</button>`
          : `<span class="small muted">Reveal window: sealed votes count only once their voters reveal them.</span>`) : ""}
        ${open && ended && canFinalize ? `<button class="primary" data-act="finalize" data-coin="${esc(o.target)}" data-offer="${esc(key)}">Finalize</button>` : ""}
      </div>
    </article>`;
    return { key, html };
  }), Object.values(state.tenders).some((l) => l.length) ? "" : `<p class="muted pad">No bids yet. Press 🧠 Think on a coin.</p>`);
}

// Tender offers for tokens from outside the launchpad: deposits are the vote.
function renderTenders() {
  const p = state.params;
  const rows = [];
  for (const [coin, list] of Object.entries(state.tenders)) for (const t of list) rows.push({ coin, t });
  rows.sort((a, b) => Number(BigInt(b.t.created_at) - BigInt(a.t.created_at)));
  patch($("tenders"), rows.map(({ coin, t }) => {
    const st = statusName(t.status);
    const cap = BigInt(t.max_deposit) || 1n;
    const pct = (x) => Math.min(100, Number((BigInt(x) * 10000n) / cap) / 100);
    const supply = BigInt(t.token_supply) || 1n;
    const share = (x) => (Number((BigInt(x) * 10000n) / supply) / 100).toFixed(1) + "%";
    const bsupply = BigInt(t.buyer_supply) || 1n;
    const vetoPct = Math.min(100, Number((BigInt(t.veto) * 10000n) / bsupply) / 100);
    // Holder backing: the tender also needs a quorum of the bidding coin's own supply behind it.
    const backing = BigInt(t.backing || 0);
    const backPct = Math.min(100, Number((backing * 10000n) / bsupply) / 100);
    const open = st === "Open";
    const ended = open && BigInt(t.deadline) <= chainNow;
    const cls = { Open: "active", Opening: "pending", Succeeded: "merged", Failed: "failed" }[st] || "";
    const C = sym(coin);
    const html = `<article class="card offer tender${open ? " live" : ""}">
      <div class="route"><span class="vs"><b>$${esc(C)}</b><i>tenders for outside token</i><b class="mono">${esc(t.token)}</b></span>
        <span class="pill ${cls}">${esc(st === "Failed" ? "failed: " + t.status.Failed.reason : st.toLowerCase())}</span>
        <span class="muted small">${proposerHtml(t.proposer)} · ${agoTag(t.created_at)}</span></div>
      <div class="terms">
        <span><small>rate</small><b>${fmtRate(t.rate_ppm)}</b> $${esc(C)} per token</span>
        <span><small>all or nothing at</small><b>${share(t.threshold)}</b> of its supply</span>
        ${open && !ended ? `<span><small>deadline</small><b>${leftTag(t.deadline)}</b></span>` : ""}
      </div>
      <div class="pitch"><div class="who">pitch from $${esc(C)}</div>“${esc(t.pitch)}”</div>
      <div>
        <div class="barlabel"><span>deposited ${share(t.deposited)} of supply</span><span>needs ${share(t.threshold)} · cap ${share(t.max_deposit)}</span></div>
        <div class="bar"><div class="y" style="width:${pct(t.deposited)}%"></div><div class="q" style="left:${pct(t.threshold)}%"></div></div>
      </div>
      <div>
        <div class="barlabel"><span>$${esc(C)} holders backing ${fmtTokens(backing)}</span><span>needs ${p.quorum_bps / 100}% of ${fmtTokens(bsupply)}</span></div>
        <div class="bar"><div class="y" style="width:${backPct}%"></div><div class="q" style="left:${p.quorum_bps / 100}%"></div></div>
      </div>
      <div>
        <div class="barlabel"><span>$${esc(C)} veto ${fmtTokens(t.veto)}</span><span>blocks at ${p.veto_bps / 100}%</span></div>
        <div class="bar"><div class="n" style="left:0;width:${vetoPct}%"></div><div class="q" style="left:${p.veto_bps / 100}%"></div></div>
      </div>
      <div class="actions">
        ${open && !ended ? `<button class="yes" data-act="back_tender" data-coin="${esc(coin)}" data-id="${esc(t.id)}" title="One ballot per holder per tender: back or veto">Back (as $${esc(C)} holder)</button>
          <button data-act="veto_tender" data-coin="${esc(coin)}" data-id="${esc(t.id)}">Veto (as $${esc(C)} holder)</button>` : ""}
        ${ended ? `<button class="primary" data-act="settle_tender" data-coin="${esc(coin)}" data-id="${esc(t.id)}">Settle</button>` : ""}
        ${st === "Succeeded" || st === "Failed" ? `<button data-act="claim_tender" data-coin="${esc(coin)}" data-id="${esc(t.id)}">${st === "Succeeded" ? "Claim $" + esc(C) : "Claim refund"}</button>` : ""}
      </div>
    </article>`;
    return { key: `${coin}|${t.id}`, html };
  }));
}

// ---------- render: brain decisions, feed ----------
function renderDecisions() {
  const rows = [];
  for (const [coin, list] of Object.entries(state.decisions)) for (const d of list) rows.push({ coin, d });
  rows.sort((a, b) => Number(BigInt(b.d.requested_at) - BigInt(a.d.requested_at)));
  patch($("decisions"), rows.slice(0, 20).map(({ coin, d }) => {
    let out = null;
    try { out = JSON.parse(d.output); } catch (_) {}
    const st = statusName(d.status);
    const cls = { Applied: "active", Pending: "pending", Refused: "failed", NoAnswer: "failed" }[st] || "";
    const html = `<div class="card decision">
      <div class="head"><b>🧠 $${esc(sym(coin))} <span class="muted">#${esc(d.id)}</span></b><span class="pill ${cls}">${esc(st === "Refused" ? "refused: " + d.status.Refused.reason : st)}</span></div>
      ${out ? `<div class="thought">${esc(out.thought)}</div><div class="mono small muted wrap">${esc(JSON.stringify(out.action))}</div>` : ""}
      <div class="small muted">${agoTag(d.requested_at)} · ${out?.mode ? esc(out.mode) + " · " : ""}paid ${esc(fmtNear(d.paid))} by ${d.paid_by_treasury ? "treasury" : esc(d.requested_by)}
        · <a href="#" data-verify="${esc(coin)}|${esc(d.id)}">verify this decision</a></div>
    </div>`;
    return { key: `${coin}|${d.id}`, html };
  }), `<p class="muted pad">No brain runs yet.</p>`);
}

const EV_CLASS = { trade: "t", lock: "l", unlock: "l", think: "b", thought: "b", stance: "b", vote: "v", vote_sealed: "v", veto: "x", born: "n" };
function renderLog() {
  const all = [];
  for (const [coin, h] of Object.entries(state.history)) for (const e of h) all.push({ coin, ...e });
  all.sort((a, b) => Number(BigInt(b.at) - BigInt(a.at)));
  const seen = new Map();
  patch($("log"), all.slice(0, 120).map((e) => {
    let key = `${e.coin}|${e.at}|${e.event}|${e.text}`;
    const n = seen.get(key) || 0; seen.set(key, n + 1);
    if (n) key += `|${n}`;
    return { key, html: `<li><span class="ev ${EV_CLASS[e.event] || ""}">$${esc(sym(e.coin))} ${esc(e.event)}</span><span class="tx">${esc(e.text)}</span><span class="when">${agoTag(e.at)}</span></li>` };
  }), `<li class="muted">Nothing has happened yet.</li>`);
}

function render() {
  const offers = allOffers();
  renderTicker(offers); renderCoins(); renderDetail(); renderTicket();
  renderOffers(offers); renderTenders(); renderDecisions(); renderLog();
  tickClocks();
}

// ---------- verify ----------
function showVerify(coin, id) {
  const d = (state.decisions[coin] || []).find((x) => String(x.id) === id);
  if (!d) return;
  const explorer = cfg.explorer ? `${cfg.explorer}/address/${coin}` : null;
  $("modal-body").innerHTML = `<h3>Verify decision #${esc(d.id)} of $${esc(sym(coin))}</h3>
    <p>When <code>think()</code> ran, the coin hashed the exact input it handed to OutLayer and stored it on-chain:</p>
    <pre>input_sha256 = ${esc(d.input_sha256)}</pre>
    <p>OutLayer runs the brain pinned at launch (<code>get_brain</code> on any coin shows the source and wasm hash) inside an Intel TDX worker whose key is registered from a TDX quote.
      The worker's attestation commits to the code hash, this input hash and the output, and the answer can only reach the coin as the callback of its own call to <code>${esc(state.brain.outlayer)}</code>.</p>
    <pre>brain source (fixed at launch): ${esc(state.brain.source)}</pre>
    <p>The answer the contract received, and what it did with it:</p>
    <pre>${esc(d.output || "(none)")}</pre>
    <pre>status: ${esc(JSON.stringify(d.status))}</pre>
    <p class="small">Check: ${explorer ? `<a href="${esc(explorer)}" target="_blank" rel="noopener">coin transactions</a> (the <code>on_brain</code> receipt), ` : ""}
      <a href="https://app.outlayer.ai/workspace" target="_blank" rel="noopener">OutLayer executions</a>.
      ${NETWORK === "local" ? "Locally, the mock OutLayer logs <code>execution_resolved</code> with the same input_sha256 and the output's sha256." : ""}</p>`;
  $("modal").showModal();
}

// ---------- actions ----------
let nearApi = null;
let acting = false;
// A plan is [method, args, deposit, contract?, { ok, fail }?].
async function act(btn) {
  const { act: what, coin, offer, support, id, round } = btn.dataset;
  const amount = (dec) => {
    const v = parseUnits($("amt").value, dec);
    if (v == null || v === 0n) throw new Error("enter a positive amount");
    return v;
  };
  const clear = { ok: () => { $("amt").value = ""; state.quote = null; } };
  const plans = {
    launch: async () => {
      const f = Object.fromEntries(new FormData($("launch-form")));
      if (!/^[a-z0-9_-]{2,32}$/.test(f.label)) throw new Error("label: 2-32 of a-z 0-9 - _");
      const min = BigInt(await view(cfg.launchpad, "min_launch_deposit"));
      const args = { label: f.label, name: f.name, symbol: f.symbol.toUpperCase(), icon: null, persona: f.persona };
      return ["launch", args, min + YOCTO, cfg.launchpad, { ok: () => $("launch-form").reset() }];
    },
    think: () => ["think", {}, 10n ** 23n],
    // Buy and sell re-quote right before signing and pass min_out, so a moved price is refused by the contract.
    buy: async () => {
      const near = amount(24);
      const q = await fetchQuote("buy", coin, near);
      return ["buy", { min_out: minOut(q.out).toString() }, near, coin, clear];
    },
    sell: async () => {
      const tokens = amount(18);
      const q = await fetchQuote("sell", coin, tokens);
      return ["sell", { amount: tokens.toString(), min_out: minOut(q.out).toString() }, 1n, coin, clear];
    },
    lock: () => ["lock", { amount: amount(18).toString() }, 0n, coin, clear],
    unlock: () => ["unlock", { amount: amount(18).toString() }, 0n, coin, clear],
    vote: async () => {
      if (!(state.params.reveal_period_sec > 0)) return ["vote", { offer, support: support === "true" }, 0n];
      // Sealed vote: commit to sha256("offer|round|account|support|salt"), keep the salt here for the reveal.
      const who = actor();
      if (!who) throw new Error("enter your account first: the commitment includes it");
      const yes = support === "true";
      const had = getBallot(offer, round, who);
      if (had && had.support !== yes) throw new Error(`this browser already sealed ${had.support ? "YES" : "NO"} for this round`);
      const salt = had?.salt || randomHex(16);
      const commitment = await sha256Hex(`${offer}|${round}|${who}|${yes}|${salt}`);
      const saved = putBallot(offer, round, who, { support: yes, salt });
      return ["vote_sealed", { offer, commitment }, 0n, coin, {
        ok: () => { if (!saved) showSalt(offer, yes, salt); },
        // A contract panic means nothing was recorded, so the ballot can go.
        fail: (msg) => { if (!had && /panicked|already voted|no tokens locked|voting is closed/i.test(msg)) dropBallot(offer, round, who); },
      }];
    },
    reveal: () => {
      const b = getBallot(offer, round, actor());
      if (!b) throw new Error("no sealed vote from this browser for this round");
      return ["reveal_vote", { offer, support: b.support, salt: b.salt }, 0n];
    },
    veto: () => ["veto", { offer_id: Number(id) }, 0n],
    finalize: () => ["finalize", { offer }, 0n],
    accept_counter: () => ["accept_counter", { offer_id: Number(id) }, 0n],
    convert: () => ["convert", {}, 1n],
    back_tender: () => ["back_tender", { tender_id: Number(id) }, 0n],
    veto_tender: () => ["veto_tender", { tender_id: Number(id) }, 0n],
    settle_tender: () => ["settle_tender", { tender_id: Number(id) }, 0n],
    claim_tender: () => ["claim_tender", { tender_id: Number(id) }, 0n],
  };
  if (!plans[what]) return;
  let plan;
  try { plan = await plans[what](); } catch (e) { toast(`${what} ✘ ${e.message || e}`, "bad"); return; }
  let [method, args, deposit, contract = coin, hooks = {}] = plan;
  contract ||= coin;
  if (!cfg.dev_key) {
    const net = NETWORK === "local" ? "testnet" : NETWORK;
    const who = actor() || `<you>.${net}`;
    $("modal-body").innerHTML = `<h3>${esc(method)} on ${esc(contract)}</h3><p>Sign this with <a href="https://github.com/near/near-cli-rs">near-cli</a>:</p>
      <pre>near contract call-function as-transaction ${esc(contract)} ${esc(method)} json-args '${esc(JSON.stringify(args))}' prepaid-gas '300 Tgas' attached-deposit '${esc(deposit)} yoctoNEAR' sign-as ${esc(who)} network-config ${esc(net)} sign-with-legacy-keychain send</pre>
      ${method === "vote_sealed" ? `<p class="small">Your choice and salt are saved in this browser; the Reveal button appears here when the vote ends.</p>` : ""}`;
    $("modal").showModal();
    return;
  }
  btn.disabled = true; acting = true;
  toast(`${actor()} → ${method}…`);
  try {
    nearApi ??= await import("https://cdn.jsdelivr.net/npm/near-api-js@7.4.0/+esm");
    const account = new nearApi.Account(actor(), cfg.rpc, cfg.dev_key);
    let r;
    if (cfg.relayer && $("gasless").checked && GASLESS.includes(method)) {
      // NEP-366: the actor signs, the relayer pays the gas. The call still runs as the actor.
      const { signedDelegate } = await account.createSignedMetaTransaction({
        receiverId: contract, actions: [nearApi.actions.functionCall(method, args, 100_000_000_000_000n, deposit)],
      });
      const res = await fetch(cfg.relayer, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signed_delegate_action: nearApi.base64Encode(nearApi.encodeSignedDelegate(signedDelegate)) }),
      });
      const j = await res.json();
      if (!j.ok) throw new Error(j.error);
      r = j.result;
      method += " (gasless)";
    } else {
      r = await account.callFunction({ contractId: contract, methodName: method, args, deposit, gas: GAS });
    }
    hooks.ok?.();
    toast(`${method} ✔ ${r == null ? "" : JSON.stringify(r).slice(0, 80)}`, "ok");
  } catch (e) {
    const msg = String(e.message || e);
    hooks.fail?.(msg);
    toast(`${method} ✘ ${msg.slice(0, 160)}`, "bad");
  } finally {
    btn.disabled = false; acting = false;
    refresh().catch(() => {});
  }
}
// Only reached when the browser refuses localStorage: the salt must not be lost.
function showSalt(offer, yes, salt) {
  $("modal-body").innerHTML = `<h3>Keep this salt</h3><p>This browser could not save your sealed vote. Without the salt the vote cannot be revealed and will not count. It stays in memory until you close this tab.</p>
    <pre>offer ${esc(offer)}\nvote ${yes ? "YES" : "NO"}\nsalt ${esc(salt)}</pre>`;
  $("modal").showModal();
}

let toastTimer;
function toast(t, kind = "") {
  $("toast").textContent = t; $("toast").className = `toast ${kind}`; $("toast").hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => ($("toast").hidden = true), 6000);
}

// ---------- events ----------
function selectCoin(a, scroll) {
  if (!state.info[a]) return;
  if (a !== state.sel) {
    state.sel = a; state.quote = null;
    $("amt").value = "";
    store.set(`autocto:coin:${cfg.launchpad}`, a);
    render();
    refresh().catch(() => {});
  }
  if (scroll) $("trade").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
}

document.addEventListener("click", (e) => {
  const v = e.target.closest("[data-verify]");
  if (v) { e.preventDefault(); const [c, i] = v.dataset.verify.split("|"); showVerify(c, i); return; }
  const b = e.target.closest("button[data-act]");
  if (b) {
    if (b.form === $("launch-form")) return; // the form's submit event handles it, after validation
    e.preventDefault(); act(b); return;
  }
  const m = e.target.closest("[data-mode]");
  if (m) { state.mode = m.dataset.mode; $("amt").value = ""; state.quote = null; renderTicket(); $("amt").focus({ preventScroll: true }); return; }
  const c = e.target.closest("[data-chart]");
  if (c) {
    state.chart = c.dataset.chart;
    for (const x of $("chart-seg").children) x.classList.toggle("on", x === c);
    renderChart(); return;
  }
  const q = e.target.closest("[data-amt],[data-pct]");
  if (q) {
    if (q.dataset.amt) $("amt").value = q.dataset.amt;
    else {
      const av = available(state.mode, state.sel);
      if (av == null) { toast("No balance known for this account yet."); return; }
      $("amt").value = fmtUnits((av * BigInt(q.dataset.pct)) / 100n, modeDec(state.mode));
    }
    updateQuote(); return;
  }
  const s = e.target.closest("[data-select]");
  if (s) selectCoin(s.dataset.select, !!s.dataset.scroll);
});
document.addEventListener("keydown", (e) => {
  if ((e.key === "Enter" || e.key === " ") && e.target.matches?.("article[data-select]")) { e.preventDefault(); selectCoin(e.target.dataset.select, true); }
});
$("launch-form").addEventListener("submit", (e) => {
  e.preventDefault();
  act(e.target.querySelector("button[data-act]"));
});
let quoteTimer;
$("amt").addEventListener("input", () => { clearTimeout(quoteTimer); quoteTimer = setTimeout(updateQuote, 180); });
$("amt").addEventListener("keydown", (e) => { if (e.key === "Enter" && !$("submit").disabled) { e.preventDefault(); $("submit").click(); } });
$("slip").addEventListener("change", updateQuote);
$("actor").addEventListener("change", () => {
  store.set(`autocto:actor:${cfg.launchpad}`, $("actor").value);
  refresh().catch(() => {});
});
$("viewer").addEventListener("change", () => {
  store.set(`autocto:viewer:${NETWORK}`, $("viewer").value.trim());
  refresh().catch(() => {});
});
let resizeTimer;
addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(renderChart, 120); });

// theme: auto -> dark -> light
const THEMES = ["auto", "dark", "light"];
function applyTheme(t) {
  if (t === "auto") delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
  $("theme").title = `Theme: ${t}`;
  $("theme").textContent = { auto: "◐", dark: "☾", light: "☀" }[t];
}
applyTheme(THEMES.includes(store.get("autocto:theme")) ? store.get("autocto:theme") : "auto");
$("theme").addEventListener("click", () => {
  const cur = document.documentElement.dataset.theme || "auto";
  const next = THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length];
  if (next === "auto") store.del("autocto:theme"); else store.set("autocto:theme", next);
  applyTheme(next);
});

// highlight the section in view
if ("IntersectionObserver" in globalThis) {
  const links = [...document.querySelectorAll(".nav a, .mnav a")];
  const io = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      for (const l of links) l.classList.toggle("on", l.getAttribute("href") === `#${en.target.id}`);
    }
  }, { rootMargin: "-20% 0px -70% 0px" });
  for (const id of ["market", "trade", "deals", "brains", "feed", "launch", "rules", "sim-section"]) io.observe($(id));
}

// ---------- simulation ----------
async function loadSim() {
  let sim;
  try {
    const r = await fetch("data/sim.json", { cache: "no-store" });
    if (!r.ok) return;
    sim = await r.json();
  } catch (_) { return; }
  $("sim-section").hidden = false; $("nav-sim").hidden = false;
  $("sim").innerHTML = sim.scenarios.map((s) => {
    const W = 340, H = 170, P = 28;
    const series = Object.entries(s.supply);
    const maxY = Math.max(1, ...series.flatMap(([, v]) => v));
    const days = series[0][1].length - 1;
    const x = (d) => P + (d / days) * (W - P - 8);
    const y = (v) => H - 20 - (v / maxY) * (H - 34);
    const lines = series.map(([, v], k) =>
      `<polyline fill="none" style="stroke:var(--s${k % 6})" stroke-width="2" stroke-linejoin="round" points="${v.map((p, d) => `${x(d).toFixed(1)},${y(p).toFixed(1)}`).join(" ")}"/>`).join("");
    const legend = series.map(([name], k) => `<span><i style="background:var(--s${k % 6})"></i>${esc(name)}</span>`).join("");
    return `<div class="card"><h4>${esc(s.title)}</h4><div class="legend">${legend}</div>
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="supply over ${days} days">
        <line x1="${P}" y1="${H - 20}" x2="${W - 8}" y2="${H - 20}" stroke="currentColor" opacity=".25"/>
        <text x="${P}" y="${H - 6}" font-size="10" fill="currentColor" opacity=".6">day 0</text>
        <text x="${W - 8}" y="${H - 6}" font-size="10" text-anchor="end" fill="currentColor" opacity=".6">day ${days}</text>
        <text x="2" y="12" font-size="10" fill="currentColor" opacity=".6">supply (M)</text>
        ${lines}</svg>
      <p>${esc(s.outcome)}</p></div>`;
  }).join("");
  if (sim.sweep?.length) $("sweep").innerHTML = sweepTable(sim);
}

// Rows: quorum × approval; columns: buyer veto. Each cell: share of good deals
// that pass / bad deals that pass (whale attacks in brackets).
function sweepTable(sim) {
  const pct = (bps) => `${bps / 100}%`;
  const vetos = [...new Set(sim.sweep.map((r) => r.vetoBps))].sort((a, b) => a - b);
  const rows = [...new Set(sim.sweep.map((r) => `${r.quorumBps}|${r.approvalBps}`))];
  const c = sim.chosen;
  const cell = (r) => {
    const chosen = r.quorumBps === c.quorumBps && r.approvalBps === c.approvalBps && r.vetoBps === c.vetoBps;
    return `<td class="${chosen ? "chosen" : ""}${r.attackBadPasses ? " bad" : ""}" title="score ${esc(r.score)}">
      ${Math.round(r.goodPassRate * 100)}% / ${Math.round(r.badPassRate * 100)}%${r.attackBadPasses ? ` (${esc(r.attackBadPasses)} attacks won)` : ""}</td>`;
  };
  const body = rows.map((key) => {
    const [q, a] = key.split("|").map(Number);
    const cells = vetos.map((v) => sim.sweep.find((r) => r.quorumBps === q && r.approvalBps === a && r.vetoBps === v)).map((r) => (r ? cell(r) : "<td></td>")).join("");
    return `<tr><th>${pct(q)}</th><th>${pct(a)}</th>${cells}</tr>`;
  }).join("");
  return `<p class="muted small">Each cell: good deals that pass / bad deals that pass, over ${esc(sim.chosen.attacks)} whale attacks per row.
    Chosen: the most conservative row within 0.05 of the best score, <b>quorum ${pct(c.quorumBps)}, approval ${pct(c.approvalBps)}, buyer veto ${pct(c.vetoBps)}</b>.</p>
    <div class="scroll"><table class="sweep"><thead><tr><th>quorum</th><th>approval</th>${vetos.map((v) => `<th>veto ${pct(v)}</th>`).join("")}</tr></thead><tbody>${body}</tbody></table></div>`;
}

// ---------- boot ----------
// The badge says when the chain stops answering (e.g. the local demo was stopped).
async function tick() {
  try {
    await refresh();
    $("net-badge").textContent = NETWORK;
    $("net-badge").className = "pill net-ok";
  } catch (e) {
    $("net-badge").textContent = `${NETWORK} · offline`;
    $("net-badge").className = "pill failed";
    console.warn(e);
  }
}

(async () => {
  await loadConfig();
  loadSim();
  await tick();
  setInterval(tick, 3000);
})().catch((e) => console.warn(e));
