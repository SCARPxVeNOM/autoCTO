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

// ---------- words explained ----------
// One plain sentence per word. Shown on hover, focus or tap, and listed under "Words explained".
const GLOSSARY = {
  "bonding curve": "The coin's built-in market. You always buy from it and sell back to it, so there is always a price. Every buy pushes the price up, every sell pushes it down.",
  lock: "Setting tokens aside so they count as votes. They stay yours and you can unlock them later. Only tokens locked before a bid was announced count for that bid.",
  brain: "The coin's AI. It runs on OutLayer inside sealed hardware, reads the market and proposes moves. It can only propose: the contract checks every number.",
  takeover: "One coin absorbs another. The smaller coin's NEAR and treasury move into the bigger one, and its holders swap their tokens at the agreed rate.",
  bid: "A coin's offer to absorb a rival: so many of its tokens for each of the rival's.",
  rate: "How many of the bidder's tokens you get for one of yours if the deal passes.",
  "fair rate": "The rate at which nobody gains or loses, taken from both coins' prices right now.",
  premium: "How much better than the fair rate the bid is. +10% means holders of the target get 10% more value than their coin trades at today.",
  quorum: "The smallest share of a coin that must vote for the result to count.",
  veto: "The bidder's own holders can block a bid, for example when their coin is overpaying.",
  tender: "An offer to holders of a token from outside this launchpad: deposit it and get this coin back. All or nothing: if too little is deposited by the deadline, everyone is refunded.",
  backing: "A tender also needs enough of the bidding coin's own holders behind it.",
  treasury: "NEAR the coin has collected from trading fees. It pays for the brain and moves along in a takeover.",
  liquidity: "The NEAR sitting in the coin's curve. It is what sellers get paid from.",
  "market cap": "Price times the tokens in circulation: roughly what the whole coin is worth.",
  slippage: "How much worse than the quoted price you accept if others trade just before you. Beyond it the trade is refused.",
  gasless: "A relayer pays the network fee for you. You still sign, so it can only do what you approved.",
  newborn: "A freshly launched coin cannot be bid for until its protection time ends.",
  "0 keys": "Nobody holds a key to the coin's account, so nobody can change its code or take its funds. Not even the people who launched it.",
  "launchpad code": "The coin runs exactly the code the launchpad ships, checked by its hash on chain.",
  watchlist: "Outside tokens that holders have nominated for a tender. The brain only considers these.",
  "sealed vote": "Votes are hidden until voting ends, so nobody can follow the crowd. You reveal yours afterwards.",
  convert: "After a takeover, swap your tokens of the absorbed coin for the winner's at the agreed rate.",
};
const term = (key, label = key) => `<span class="term" tabindex="0" data-term="${esc(key)}">${esc(label)}</span>`;

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
// A single token costs a tiny fraction of a NEAR, so prices are shown per 1M tokens.
const fmtPrice = (p) => `${fmtSig(p * 1e6)} Ⓝ`;
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
// Contract texts carry raw integers and account ids: make them readable.
function humanize(text) {
  let t = String(text ?? "");
  t = t.replace(/\b\d{20,}\b/g, (m) => fmtTokens(m));
  t = t.replace(/\b(\d{5,}) tokens\b/g, (_, n) => `${compact(Number(n))} tokens`);
  t = t.replace(/([+-]?\d+) bps/g, (_, n) => `${n.startsWith("+") ? "+" : ""}${(Number(n) / 100).toFixed(1)}%`);
  for (const { account_id: a } of state.coins) if (state.info[a]) t = t.split(a).join(`$${state.info[a].symbol}`);
  return t;
}
// The reason inside a contract panic, without the wrapping.
function plainError(msg) {
  const m = /Smart contract panicked: ([^"\\]+)/.exec(msg) || /"ExecutionError":"([^"]+)"/.exec(msg);
  return (m ? m[1] : String(msg)).trim().slice(0, 180);
}
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
  $("mode-note").innerHTML = cfg.dev_key
    ? `<b>Demo mode.</b><span>Everything here is play money on a local chain. Use “playing as” at the top to switch between demo holders and see every side of a deal.</span>`
    : NETWORK === "testnet"
      ? `<b>Testnet.</b><span>Test NEAR only: nothing here costs real money. Connect a testnet wallet to trade, or just look around.</span>`
      : "";
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
    $("connect").hidden = !hasWallet();
    if (hasWallet()) restoreWallet();
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
  const mins = (sec) => (sec % 3600 === 0 ? `${sec / 3600} h` : sec >= 120 ? `${Math.round(sec / 60)} min` : `${sec} s`);
  const cards = [
    [mins(p.vote_period_sec), "to vote", "Each bid is open for this long. Nothing happens before the vote ends."],
    [`${p.quorum_bps / 100}%`, "must take part", `At least this share of the target coin has to vote, or the bid fails.`],
    [`${p.approval_bps / 100}%`, "must say yes", "Of the votes cast. A simple majority is not enough."],
    [`${p.veto_bps / 100}%`, "can block", "If this share of the bidder's own holders vetoes, the bid is off."],
    [`±${p.max_premium_bps / 100}%`, "price limit", "A bid can be at most this far above or below the fair rate, so nobody is robbed by a silly price."],
    [mins(p.newborn_protection_sec), "newborn protection", "A new coin cannot be bid for until this much time has passed."],
    [`${p.max_offers_per_day} a day`, "bids per coin", `And a ${mins(p.rebid_cooldown_sec)} wait before bidding for the same coin again. No spam.`],
    [`${p.trade_fee_bps / 100}%`, "trading fee", "Goes to the coin's own treasury, which pays for its brain. No team cut."],
    ...(p.tender_threshold_bps ? [[`${p.tender_threshold_bps / 100}%`, "for a tender", `A tender for an outside token only happens if this share of its supply is deposited within ${mins(p.tender_period_sec)}. Otherwise everyone is refunded.`]] : []),
    ["0 keys", "no owner", "No account can change a coin's code, rules or funds after launch."],
  ];
  $("rules-cards").innerHTML = cards.map(([v, k, t]) => `<div><b>${esc(v)}</b><span>${esc(k)}</span><p>${esc(t)}</p></div>`).join("");
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
  if (st === "Merged") return [`absorbed by $${esc(sym(info.status.Merged.into))}`, "merged"];
  if (st === "MergePending") return ["merging…", "pending"];
  if (chainNow < BigInt(info.protected_until)) return [`newborn · ${leftTag(info.protected_until)}`, "newborn"];
  return ["trading", "active"];
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
  return `<span class="badge ${state.keys[a] === 0 ? "ok" : "bad"}" data-term="0 keys" tabindex="0">${state.keys[a] === 0 ? "🔒 0 keys" : `${esc(state.keys[a] ?? "?")} keys`}</span>
    <span class="badge ${same ? "ok" : "bad"}" data-term="launchpad code" tabindex="0">${same ? "✔ launchpad code" : "code ?"}</span>
    ${i.absorbed.map(([t]) => `<span class="badge ate">ate $${esc(sym(t))}</span>`).join("")}
    ${(i.watchlist || []).map((t) => `<span class="badge" data-term="watchlist" tabindex="0">👀 ${esc(short(t))}</span>`).join("")}`;
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
      <div class="c num${flash}" data-l="Price / 1M">${merged ? "–" : fmtPrice(p)}</div>
      <div class="c c-spark" data-l="Session">${merged ? "" : sparkline(a)}${ch == null || merged ? "" : `<span class="chg ${ch >= 0 ? "up" : "down"}">${fmtPct(ch)}</span>`}</div>
      <div class="c num" data-l="Market cap">${merged ? "–" : esc(fmtNear(marketCap(i)))}</div>
      <div class="c num" data-l="Liquidity">${esc(fmtNear(curveReal(i)))}</div>
      <div class="c num" data-l="Treasury">${esc(fmtNear(i.treasury))}</div>
      <div class="c num" data-l="You hold">${who ? esc(fmtTokens(mine)) : "–"}</div>
      <div class="c c-status"><span class="pill ${cls}">${label}</span></div>
    </article>`;
    return { key: a, html };
  }), `<p class="muted pad">No coins yet. Be the first: <a href="#launch">launch one</a>.</p>`);

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
      <div class="ch-price"><div class="bigprice mono">${merged ? "absorbed" : fmtPrice(priceNum(i))}</div>
        <div class="small">${merged ? "" : `<span class="muted">per 1M $${esc(i.symbol)}</span>`}${ch == null || merged ? "" : ` · <span class="chg ${ch >= 0 ? "up" : "down"}">${fmtPct(ch)}</span> <span class="muted">since you opened this page</span>`}</div></div>
    </div>
    <p class="persona">${esc(i.persona)}</p>
    <div class="badges"><span class="pill ${cls}">${label}</span>${badges(a)}</div>`);
  const rows = [
    ["market cap", merged ? "–" : fmtNear(marketCap(i)), "market cap"], ["liquidity", fmtNear(curveReal(i)), "liquidity"],
    ["treasury", fmtNear(i.treasury), "treasury"],
    ["in circulation", fmtTokens(i.circulating)], ["locked for votes", fmtTokens(i.total_locked), "lock"],
    ["total supply", fmtTokens(i.total_supply)],
    ...(BigInt(i.owed || 0) > 0n ? [["owed to converters", fmtTokens(i.owed), "convert"]] : []),
    ["brain spent", fmtNear(i.brain_spent_total), "brain"], ["brain decisions", String(i.decisions)],
  ];
  setHTML($("coin-stats"), rows.map(([k, v, t]) => `<div><dt>${t ? term(t, k) : esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("")
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
  $("chart-note").textContent = `Every buy moves the dot up the line, every sell moves it down · started at ${fmtPrice(price(0))} per 1M`;
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
    <text class="lbl strong" x="${(cx + (leftSide ? -12 : 12)).toFixed(1)}" y="${(cy + (leftSide ? -22 : 16)).toFixed(1)}" text-anchor="${leftSide ? "end" : "start"}">now ${fmtPrice(price(real))} / 1M</text>
    <text class="lbl" x="${(cx + (leftSide ? -12 : 12)).toFixed(1)}" y="${(cy + (leftSide ? -8 : 30)).toFixed(1)}" text-anchor="${leftSide ? "end" : "start"}">${real.toFixed(2)} Ⓝ paid in so far</text>
    <text class="lbl" x="${L}" y="${H - 8}">0 Ⓝ paid in</text>
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
    <text class="lbl" x="${L}" y="${(sy(hi) - 6).toFixed(1)}">${hi === lo ? "" : "high "}${fmtPrice(hi)} / 1M</text>
    ${hi === lo ? "" : `<text class="lbl" x="${L}" y="${(sy(lo) + 14).toFixed(1)}">low ${fmtPrice(lo)} / 1M</text>`}
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
  $("think-note").textContent = `Wakes $${s}'s AI to look for a deal. Costs ${fmtNear(state.params.brain_fee)}; it has used ${fmtNear(i.brain_spent_today)} of ${fmtNear(state.params.brain_daily_cap)} today.`;

  // position
  const who = state.me.acct;
  $("pos-who").textContent = who || "";
  const until = state.me.until[a] || 0n;
  setHTML($("pos"), !who
    ? `<div><dt class="muted">${cfg.dev_key ? "No account selected." : hasWallet() ? "Connect a wallet to see your balances here." : "Type your account at the top to see balances."}</dt></div>`
    : `<div><dt>$${esc(s)} you can sell</dt><dd>${esc(fmtTokens(state.me.bal[a] || 0n))}</dd></div>
       <div><dt>$${esc(s)} ${term("lock", "locked for votes")}</dt><dd>${esc(fmtTokens(lockedOf(a)))}</dd></div>
       <div><dt>NEAR</dt><dd>${state.me.near == null ? "–" : esc(fmtNear(state.me.near))}</dd></div>
       ${until > chainNow ? `<div><dt>backing a vote</dt><dd>${leftTag(until)}</dd></div>` : ""}`);
  const lots = state.me.locks[a] || [];
  setHTML($("lots"), lots.length
    ? `<div class="small muted">Your locks · each one counts for bids announced after it was made</div>`
      + lots.map((l) => `<div class="lot"><span class="mono">${esc(fmtTokens(l.amount))} $${esc(s)}</span><span class="muted small">locked ${agoTag(l.since)}</span></div>`).join("")
    : who ? `<div class="small muted">Nothing locked yet. Lock some $${esc(s)} to vote when another coin bids for it, and to veto $${esc(s)}'s own bids.</div>` : "");
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
    buy: `You pay NEAR and get $${i.symbol} at the current price. ${state.params.trade_fee_bps / 100}% goes to the coin's own treasury.`,
    sell: `You give $${i.symbol} back and get NEAR at the current price. Locked tokens must be unlocked first.`,
    lock: "Locking gives you a vote. The tokens stay yours and you can unlock later. Lock before a bid is announced, or it won't count for that bid.",
    unlock: "Makes locked tokens sellable again. Newest locks are released first.",
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
        <div><dt>Your price per 1M</dt><dd>${fmtPrice(avg)}</dd></div>
        <div><dt title="How far your price is from the current price, fee included. Bigger trades move the price more.">Price impact + fee</dt><dd class="${impact > 0.05 ? "down" : ""}">${(impact * 100).toFixed(2)}%</dd></div>
        <div><dt title="If the price moves and you would get less than this, the trade is refused and you keep your money">You get at least</dt><dd>${recv(minOut(quote.out))}</dd></div>`;
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
    const prem = o.premium_bps / 100;
    const say = `<b>$${esc(B)}</b> wants to absorb <b>$${esc(T)}</b>. Each $${esc(T)} would become ${fmtRate(o.rate_ppm)} $${esc(B)}, <span class="${prem >= 0 ? "up" : "down"}">${Math.abs(prem).toFixed(1)}% ${prem >= 0 ? "more" : "less"}</span> than it is worth today.`;
    const sayNow = st === "Executed" ? `Done: $${esc(T)} is now part of $${esc(B)}. Its holders can convert.`
      : st === "Failed" ? `It did not go through: ${esc(o.status.Failed.reason)}.`
      : !open ? "The merge is being carried out."
      : !ended ? `Voting is open. It passes if at least ${quorum}% of $${esc(T)} votes and ${p.approval_bps / 100}% of the votes say yes.`
      : inReveal ? "Voting has ended. Sealed votes are being revealed."
      : "Voting has ended. Anyone can press Finalize to count the votes.";
    // What this account can do here: only lots locked before the bid count.
    const before = (coin) => (state.me.locks[coin] || []).filter((l) => BigInt(l.since) < BigInt(o.created_at)).reduce((x, l) => x + BigInt(l.amount), 0n);
    let move = "";
    if (open && !ended && who) {
      const vt = before(o.target), vb = before(o.buyer);
      move = vt > 0n ? `<div class="move can"><i>🗳</i><span>You have ${fmtTokens(vt)} $${esc(T)} locked from before this bid, so you can vote.</span></div>`
        : vb > 0n ? `<div class="move can"><i>🛡</i><span>You have ${fmtTokens(vb)} $${esc(B)} locked: you can veto if you think $${esc(B)} is overpaying.</span></div>`
        : `<div class="move"><i>👀</i><span>You have no $${esc(T)} or $${esc(B)} that was locked before this bid, so you can only watch this one. Lock tokens now to have a say in the next.</span></div>`;
    }
    const voteBtns = ballot
      ? `<span class="small muted">You sealed <b>${ballot.support ? "YES" : "NO"}</b>. Come back to reveal it when the vote ends.</span>`
      : `<button class="yes" data-act="vote" data-coin="${esc(o.target)}" data-offer="${esc(key)}" data-round="${esc(o.round)}" data-support="true">${sealedMode ? "Seal YES" : "Vote YES"}</button>
         <button class="no" data-act="vote" data-coin="${esc(o.target)}" data-offer="${esc(key)}" data-round="${esc(o.round)}" data-support="false">${sealedMode ? "Seal NO" : "Vote NO"}</button>`;
    const html = `<article class="card offer${open ? " live" : ""}">
      <div class="route"><span class="vs"><b>$${esc(B)}</b><i>bids for</i><b>$${esc(T)}</b></span>
        <span class="pill ${cls}">${esc(st === "Failed" ? "failed: " + o.status.Failed.reason : st.toLowerCase())}</span>
        <span class="muted small">${proposerHtml(o.proposer)} · ${agoTag(o.created_at)}</span></div>
      <p class="say">${say} <span class="muted">${sayNow}</span></p>
      ${move}
      <div class="terms">
        <span><small>${term("rate")}</small><b>${fmtRate(o.rate_ppm)}</b> $${esc(B)} per $${esc(T)}</span>
        <span><small>${term("fair rate")}</small><b>${fmtRate(o.fair_rate_ppm)}</b></span>
        <span><small>${term("premium")}</small><b class="${o.premium_bps >= 0 ? "up" : "down"}">${fmtBps(o.premium_bps)}</b></span>
        <span><small>round</small><b>${esc(o.round)}</b></span>
        ${open && !ended ? `<span><small>vote</small><b>${leftTag(o.vote_ends)}</b></span>` : ""}
        ${open && inReveal ? `<span><small>reveal window</small><b>${leftTag(revealEnds)}</b></span>` : ""}
      </div>
      <div class="pitch"><div class="who">pitch from $${esc(B)}'s brain · an ad, not a fact</div>“${esc(humanize(o.pitch))}”</div>
      ${o.counter ? `<div class="pitch"><div class="who">counter from $${esc(T)}: ${fmtRate(o.counter.rate_ppm)}</div>“${esc(o.counter.pitch)}”</div>` : ""}
      ${stance ? `<div class="pitch brain"><div class="who">what $${esc(T)}'s brain tells its holders</div>${esc(humanize(stance))}</div>` : ""}
      <div>
        <div class="barlabel"><span><b class="up">yes ${fmtTokens(yes)}</b> · <b class="down">no ${fmtTokens(no)}</b>${sealedMode || sealed > 0n ? ` · sealed ${fmtTokens(sealed)} <span title="Sealed votes count only once revealed">(direction hidden)</span>` : ""}</span><span>${term("quorum", "needs")} ${quorum}% of ${fmtTokens(circ)} to vote</span></div>
        <div class="bar"><div class="y" style="width:${pct(yes)}%"></div><div class="n" style="left:${pct(yes)}%;width:${pct(no)}%"></div><div class="s" style="left:${pct(yes + no)}%;width:${pct(sealed)}%"></div><div class="q" style="left:${quorum}%"></div></div>
      </div>
      <div>
        <div class="barlabel"><span>$${esc(B)} holders ${term("veto", "against")} ${fmtTokens(o.veto || 0)}</span><span>blocked at ${p.veto_bps / 100}%</span></div>
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
  }), Object.values(state.tenders).some((l) => l.length) ? "" : `<p class="muted pad">No deals yet. Open a coin and press <b>🧠 Think</b>: its brain looks at the rivals and may make the first bid.</p>`);
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
    const sayNow = st === "Succeeded" ? "It worked: enough was deposited. Depositors can claim their coins."
      : st === "Failed" ? `It did not go through: ${esc(t.status.Failed.reason)}. Depositors can take their tokens back.`
      : st === "Opening" ? "The brain is checking that the token's owner cannot rug it."
      : ended ? "The deadline has passed. Anyone can press Settle." : "";
    const html = `<article class="card offer tender${open ? " live" : ""}">
      <div class="route"><span class="vs"><b>$${esc(C)}</b><i>tenders for outside token</i><b class="mono">${esc(t.token)}</b></span>
        <span class="pill ${cls}">${esc(st === "Failed" ? "failed: " + t.status.Failed.reason : st.toLowerCase())}</span>
        <span class="muted small">${proposerHtml(t.proposer)} · ${agoTag(t.created_at)}</span></div>
      <p class="say"><b>$${esc(C)}</b> offers holders of the outside token <b>${esc(short(t.token))}</b> a swap: ${fmtRate(t.rate_ppm)} $${esc(C)} for each token they deposit. ${term("tender", "All or nothing")}: it only happens if ${share(t.threshold)} of that token's supply is deposited in time. <span class="muted">${sayNow}</span></p>
      <div class="terms">
        <span><small>rate</small><b>${fmtRate(t.rate_ppm)}</b> $${esc(C)} per token</span>
        <span><small>all or nothing at</small><b>${share(t.threshold)}</b> of its supply</span>
        ${open && !ended ? `<span><small>deadline</small><b>${leftTag(t.deadline)}</b></span>` : ""}
      </div>
      <div class="pitch"><div class="who">pitch from $${esc(C)}'s brain</div>“${esc(humanize(t.pitch))}”</div>
      <div>
        <div class="barlabel"><span>deposited ${share(t.deposited)} of supply</span><span>needs ${share(t.threshold)} · cap ${share(t.max_deposit)}</span></div>
        <div class="bar"><div class="y" style="width:${pct(t.deposited)}%"></div><div class="q" style="left:${pct(t.threshold)}%"></div></div>
      </div>
      <div>
        <div class="barlabel"><span>$${esc(C)} holders ${term("backing")} ${fmtTokens(backing)}</span><span>needs ${p.quorum_bps / 100}% of ${fmtTokens(bsupply)}</span></div>
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

// What a brain's answer means, in a sentence.
function describeAction(coin, a) {
  const me = `$${sym(coin)}`;
  const offerName = (key) => { const [b, n] = String(key).split("#"); return `$${sym(b)}'s bid #${n}`; };
  switch (a?.type) {
    case "none": return "Decided to wait.";
    case "offer": return `Bids for $${sym(a.target)}: ${fmtRate(a.rate_ppm)} ${me} for each $${sym(a.target)}.`;
    case "counter": return `Asks for more on ${offerName(a.offer)}: ${fmtRate(a.rate_ppm)} per token.`;
    case "accept_counter": return `Accepts the counter-offer on its bid #${a.offer_id}.`;
    case "stance": return `Tells its holders to vote ${a.support ? "YES" : "NO"} on ${offerName(a.offer)}.`;
    case "tender": return `Opens a tender for the outside token ${short(a.token)}: ${fmtRate(a.rate_ppm)} ${me} per token.`;
    default: return a ? JSON.stringify(a) : "";
  }
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
      ${out ? `<div class="thought">“${esc(humanize(out.thought))}”</div><div class="did" title="${esc(JSON.stringify(out.action))}">→ ${esc(describeAction(coin, out.action))}</div>` : st === "Pending" ? `<div class="muted">Thinking… the answer arrives in a few seconds.</div>` : ""}
      <div class="small muted">${agoTag(d.requested_at)} · ${out?.mode ? esc(out.mode) + " · " : ""}woken by ${esc(short(d.requested_by))} · cost ${esc(fmtNear(d.paid))}${d.paid_by_treasury ? " from the treasury" : ""}
        · <a href="#" data-verify="${esc(coin)}|${esc(d.id)}">proof</a></div>
    </div>`;
    return { key: `${coin}|${d.id}`, html };
  }), `<p class="muted pad">No brain has been woken yet. Open a coin and press 🧠 Think.</p>`);
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
    return { key, html: `<li><span class="ev ${EV_CLASS[e.event] || ""}">$${esc(sym(e.coin))} ${esc(e.event.replace(/_/g, " "))}</span><span class="tx">${esc(humanize(e.text))}</span><span class="when">${agoTag(e.at)}</span></li>` };
  }), `<li class="muted">Nothing has happened yet.</li>`);
}

// First steps: each one ticks itself off from what the chain says about this account.
function renderGuide() {
  const who = state.me.acct, me = state.me;
  const locked = Object.values(me.locks).some((l) => l.length);
  const holds = locked || Object.values(me.bal).some((b) => b > 0n);
  const events = Object.values(state.history).flat();
  const did = (names) => !!who && events.some((e) => names.includes(e.event) && e.text.startsWith(`${who} `));
  const fee = fmtNear(state.params.brain_fee);
  const steps = [
    cfg.dev_key
      ? [!!who, "Pick a demo holder", `You are playing as ${short(who) || "nobody"}, with play money. Switch any time at the top.`, "who", "Switch holder"]
      : [!!who, hasWallet() ? "Connect a wallet" : "Enter your account", hasWallet() ? "A free NEAR testnet wallet. No real money is involved." : "Type your account at the top to see your balances.", "who", hasWallet() ? "Connect" : "Enter account"],
    [holds, "Buy your first coin", "Pick any coin, type how much NEAR to spend and press Buy. You can sell back any time.", "buy", "Buy a coin"],
    [locked, "Lock some to get a vote", "Locking keeps the tokens yours and makes them count as votes. Do it before a bid shows up.", "lock", "Lock tokens"],
    [did(["think"]), "Wake a brain", `Press Think and the coin's AI looks at its rivals. It may make a bid. Costs ${fee}.`, "think", "Show me"],
    [did(["vote", "vote_sealed", "veto", "tender_backed", "tender_veto"]), "Have your say on a deal", "Open bids appear under Deals. Vote yes or no with what you locked.", "deals", "See the deals"],
  ];
  // Once done, a step stays done even when the event scrolls out of the coin's history.
  const key = `autocto:guide:${cfg.launchpad}:${who}`;
  const saved = who ? Number(store.get(key) || 0) : 0;
  let mask = 0;
  steps.forEach((x, k) => { if (x[0] || (saved >> k) & 1) { x[0] = true; mask |= 1 << k; } });
  if (who && mask !== saved) store.set(key, String(mask));
  const next = steps.findIndex((x) => !x[0]);
  const done = steps.filter((x) => x[0]).length;
  $("guide-progress").textContent = done === steps.length ? "All done. You know how it works." : `${done} of ${steps.length} done`;
  $("nav-guide").hidden = done === steps.length; $("nav-guide").textContent = `${done}/${steps.length}`;
  setHTML($("guide-steps"), steps.map(([ok, t, text, go, btn], k) =>
    `<li class="${ok ? "done" : k === next ? "next" : ""}"><span class="tick" aria-hidden="true">${ok ? "✓" : k + 1}</span><b>${esc(t)}</b><p>${esc(text)}</p>
      ${ok && go !== "who" ? "" : `<button type="button" class="${k === next ? "primary" : ""}" data-go="${go}">${esc(btn)}</button>`}</li>`).join(""));
}

function render() {
  const offers = allOffers();
  renderGuide();
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

// ---------- wallet (testnet, mainnet) ----------
// NEAR Connect shows the wallet picker and passes transactions to the chosen wallet,
// which runs in its own sandboxed frame. Keys never touch this page.
const NEAR_API = "https://cdn.jsdelivr.net/npm/near-api-js@7.4.0/+esm";
const NEAR_CONNECT = "https://cdn.jsdelivr.net/npm/@hot-labs/near-connect@0.12.0/+esm";
const hasWallet = () => !cfg.dev_key && (NETWORK === "testnet" || NETWORK === "mainnet");
let connector = null, walletAcct = null;
function setWallet(acct) {
  walletAcct = acct || null;
  $("connect").textContent = walletAcct ? "Disconnect" : "Connect wallet";
  $("connect").className = walletAcct ? "" : "primary";
  $("viewer").readOnly = !!walletAcct;
  if (walletAcct) { $("viewer").value = walletAcct; store.set(`autocto:viewer:${NETWORK}`, walletAcct); }
  refresh().catch(() => {});
}
async function getConnector() {
  if (connector) return connector;
  const { NearConnector } = await import(NEAR_CONNECT);
  connector = new NearConnector({ network: NETWORK });
  connector.on("wallet:signIn", (t) => { setWallet(t.accounts?.[0]?.accountId); if (walletAcct) toast(`Connected as ${walletAcct}`, "ok"); });
  connector.on("wallet:signOut", () => setWallet(null));
  return connector;
}
// A wallet connected on an earlier visit is picked up again.
async function restoreWallet() {
  try {
    const c = await getConnector();
    const { accounts } = await c.getConnectedWallet();
    if (accounts?.[0]?.accountId) setWallet(accounts[0].accountId);
  } catch (_) {}
}
async function connectWallet() {
  try {
    const c = await getConnector();
    if (walletAcct) await c.disconnect(); else await c.connect();
  } catch (e) {
    // Closing the picker is not an error worth a message.
    if (!/reject|cancel|closed/i.test(String(e?.message || e))) toast(`Could not open the wallet: ${e?.message || e}`, "bad");
  }
}
async function walletCall(contract, method, args, deposit) {
  const c = await getConnector();
  const wallet = await c.wallet();
  return wallet.signAndSendTransaction({
    receiverId: contract,
    actions: [{ type: "FunctionCall", params: { methodName: method, args, gas: GAS.toString(), deposit: BigInt(deposit).toString() } }],
  });
}

// ---------- actions ----------
// What each action is called while it runs and once it is done.
const SAY = {
  launch: ["Launching your coin", "Your coin is live. It shows up in the market in a moment."],
  think: ["Waking the brain", "The brain is thinking. Its decision appears under Brain decisions in a few seconds."],
  buy: ["Buying", "Bought. The tokens are in your wallet."],
  sell: ["Selling", "Sold. The NEAR is in your wallet."],
  lock: ["Locking", "Locked. These tokens now count in votes on bids announced from here on."],
  unlock: ["Unlocking", "Unlocked. You can sell these tokens again."],
  vote: ["Casting your vote", "Your vote is in."],
  reveal: ["Revealing your vote", "Your vote is revealed and counted."],
  veto: ["Sending your veto", "Your veto is in."],
  finalize: ["Counting the votes", "The vote is counted. See the deal for the result."],
  accept_counter: ["Accepting the counter-offer", "Counter-offer accepted. A new voting round starts."],
  convert: ["Converting", "Converted. You now hold the winning coin."],
  back_tender: ["Backing the tender", "You backed this tender."],
  veto_tender: ["Sending your veto", "Your veto is in."],
  settle_tender: ["Settling the tender", "The tender is settled."],
  claim_tender: ["Claiming", "Claimed. Check your wallet."],
};
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
  const [doing, doneText] = SAY[what] || [what, "Done."];
  try { plan = await plans[what](); } catch (e) { toast(`${e.message || e}`, "bad"); return; }
  let [method, args, deposit, contract = coin, hooks = {}] = plan;
  contract ||= coin;
  if (!cfg.dev_key) {
    const net = NETWORK === "local" ? "testnet" : NETWORK;
    const who = actor() || `<you>.${net}`;
    const cli = `<pre>near contract call-function as-transaction ${esc(contract)} ${esc(method)} json-args '${esc(JSON.stringify(args))}' prepaid-gas '300 Tgas' attached-deposit '${esc(deposit)} yoctoNEAR' sign-as ${esc(who)} network-config ${esc(net)} sign-with-legacy-keychain send</pre>`;
    const sealedNote = method === "vote_sealed" ? `<p class="small">Your choice and salt are saved in this browser; the Reveal button appears here when the vote ends.</p>` : "";
    if (hasWallet() && !walletAcct) { toast("Connect a wallet first, so the page knows which account is yours."); connectWallet(); return; }
    if (!hasWallet()) {
      $("modal-body").innerHTML = `<h3>${esc(doing)}</h3><p>This page has no wallet for this network. Sign the call with <a href="https://github.com/near/near-cli-rs">near-cli</a>:</p>${cli}${sealedNote}`;
      $("modal").showModal();
      return;
    }
  }
  btn.disabled = true; acting = true;
  toast(cfg.dev_key ? `${doing}…` : `${doing}: approve it in your wallet…`);
  let gasless = false;
  try {
    let r, account;
    if (cfg.dev_key) {
      nearApi ??= await import(NEAR_API);
      account = new nearApi.Account(actor(), cfg.rpc, cfg.dev_key);
    }
    if (!cfg.dev_key) {
      r = await walletCall(contract, method, args, deposit);
    } else if (cfg.relayer && $("gasless").checked && GASLESS.includes(method)) {
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
      gasless = true;
    } else {
      r = await account.callFunction({ contractId: contract, methodName: method, args, deposit, gas: GAS });
    }
    hooks.ok?.();
    toast(`${doneText}${gasless ? " The relayer paid the fee." : ""}`, "ok");
  } catch (e) {
    const msg = String(e.message || e);
    hooks.fail?.(msg);
    toast(/reject|cancel|denied/i.test(msg) && !cfg.dev_key ? "Cancelled in the wallet. Nothing was sent." : `That didn't go through: ${plainError(msg)}`, "bad");
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
  if (scroll) setView("market", false);
  if (scroll) $("trade").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
}

// ---------- views ----------
// The page shows one view at a time; the address hash picks it (and the section inside it).
const VIEW_OF = { market: "market", guide: "market", trade: "market", deals: "deals", brains: "brains", feed: "brains", launch: "launch", rules: "rules", "sim-section": "rules" };
function setView(id, scroll = true) {
  const view = VIEW_OF[id] || "market";
  const changed = document.body.dataset.view !== view;
  document.body.dataset.view = view;
  for (const el of document.querySelectorAll("[data-v]")) el.classList.toggle("off", el.dataset.v !== view);
  for (const l of document.querySelectorAll(".nav a[href^='#'], .mnav a[href^='#']")) l.classList.toggle("on", VIEW_OF[l.getAttribute("href").slice(1)] === view && l.getAttribute("href") !== "#guide");
  if (changed) renderChart();
  if (!scroll) return;
  const first = { market: "guide", deals: "deals", brains: "brains", launch: "launch", rules: "rules" }[view];
  if (id === first || !VIEW_OF[id]) scrollTo({ top: 0 }); else $(id)?.scrollIntoView({ block: "start" });
}
addEventListener("hashchange", () => setView(location.hash.slice(1)));
// "What is AutoCTO" keeps the network the visitor is on.
for (const a of document.querySelectorAll("[data-home]")) a.href = `index.html${location.search}`;

// Jump to the place a first step is done, and point at it.
function go(where) {
  const smooth = matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
  const point = (el, block = "center") => {
    el.scrollIntoView({ behavior: smooth, block });
    el.classList.remove("ring"); void el.offsetWidth; el.classList.add("ring");
  };
  if (where === "who") {
    const el = cfg.dev_key ? $("actor") : walletAcct || !hasWallet() ? $("viewer") : $("connect");
    point(el); el.focus({ preventScroll: true });
  } else if (where === "buy" || where === "lock") {
    // Lock needs a coin this account holds; buy needs one that still trades.
    const ids = state.coins.map((c) => c.account_id).filter((a) => !isMerged(state.info[a]));
    const want = where === "lock" ? ids.find((a) => (state.me.bal[a] || 0n) > 0n) : ids.includes(state.sel) ? state.sel : ids[0];
    setView("market", false);
    if (where === "lock" && !want) { toast("Buy a coin first: you can only lock tokens you hold."); return go("buy"); }
    if (want && want !== state.sel) selectCoin(want, false);
    state.mode = where; $("amt").value = ""; state.quote = null; renderTicket();
    point($("ticket")); $("amt").focus({ preventScroll: true });
  } else if (where === "think") { setView("market", false); point($("think")); }
  else if (where === "deals") location.hash = "#deals";
}

function showGlossary() {
  $("modal-body").innerHTML = `<h3>Words explained</h3><dl class="glossary">${Object.entries(GLOSSARY).map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl>`;
  $("modal").showModal();
}

// One floating explanation for every [data-term]: hover, keyboard focus or tap.
let tipFor = null;
function showTip(el) {
  const key = el.dataset.term, text = GLOSSARY[key];
  if (!text) return;
  const tip = $("tip");
  tip.innerHTML = `<b>${esc(key)}</b>${esc(text)}`;
  tip.hidden = false; tipFor = el;
  const r = el.getBoundingClientRect(), t = tip.getBoundingClientRect();
  const x = Math.max(12, Math.min(innerWidth - t.width - 12, r.left + r.width / 2 - t.width / 2));
  const above = r.top - t.height - 8;
  tip.style.left = `${x}px`; tip.style.top = `${above > 8 ? above : r.bottom + 8}px`;
}
function hideTip() { $("tip").hidden = true; tipFor = null; }
document.addEventListener("mouseover", (e) => { const el = e.target.closest?.("[data-term]"); if (el) showTip(el); else if (tipFor) hideTip(); });
document.addEventListener("focusin", (e) => { const el = e.target.closest?.("[data-term]"); if (el) showTip(el); });
document.addEventListener("focusout", hideTip);
addEventListener("scroll", hideTip, { passive: true });

document.addEventListener("click", (e) => {
  const g = e.target.closest("[data-go]");
  if (g) { go(g.dataset.go); return; }
  if (e.target.closest("[data-glossary]")) { e.preventDefault(); showGlossary(); return; }
  if (e.target.closest("#connect, [data-connect]")) { connectWallet(); return; }
  const pp = e.target.closest("[data-persona]");
  if (pp) { $("launch-form").elements.persona.value = pp.dataset.persona; return; }
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
// Launch form: show the coin taking shape, and suggest an address from the name.
function launchPreview(e) {
  const f = $("launch-form").elements;
  if (e?.target === f.symbol) f.symbol.value = f.symbol.value.toUpperCase();
  if (e?.target === f.name && !f.label.dataset.touched) f.label.value = f.name.value.toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 32);
  if (e?.target === f.label) f.label.dataset.touched = "1";
  const symbol = f.symbol.value.trim();
  $("launch-ava").textContent = symbol.slice(0, 2) || "?";
  $("launch-ava").style.setProperty("--h", hue(symbol || "?"));
  $("launch-title").textContent = symbol ? `$${symbol} ${f.name.value}` : f.name.value || "Your coin";
  $("launch-addr").textContent = `${f.label.value || "name"}.${cfg.launchpad || ""}`;
}
$("launch-form").addEventListener("input", launchPreview);
$("launch-form").addEventListener("reset", () => { delete $("launch-form").elements.label.dataset.touched; setTimeout(launchPreview); });

// Intro and first steps can be folded away; the choice is remembered.
function fold(key, cls, btn, on, labels) {
  document.body.classList.toggle(cls, on);
  $(btn).textContent = labels[on ? 1 : 0];
  if (on) store.set(key, "1"); else store.del(key);
}
const foldGuide = (on) => fold("autocto:no-guide", "guide-off", "guide-toggle", on, ["Hide", "Show"]);
foldGuide(store.get("autocto:no-guide") === "1");
$("guide-toggle").addEventListener("click", () => foldGuide(!document.body.classList.contains("guide-off")));

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

// ---------- simulation ----------
async function loadSim() {
  let sim;
  try {
    const r = await fetch("data/sim.json", { cache: "no-store" });
    if (!r.ok) return;
    sim = await r.json();
  } catch (_) { return; }
  $("sim-section").hidden = false;
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

setView(location.hash.slice(1), false);
(async () => {
  await loadConfig();
  launchPreview();
  loadSim();
  await tick();
  setInterval(tick, 3000);
})().catch((e) => console.warn(e));
