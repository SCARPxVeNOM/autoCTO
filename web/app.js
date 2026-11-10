// AutoCTO page: reads every coin straight from NEAR RPC. No backend.
// ?network=local   -> config.local.json (written by `cargo run -p autocto-demo`)
// ?network=testnet -> config.testnet.json (written by `cargo run -p autocto-demo --bin deploy`)
// ?rpc=...&launchpad=... override either.

const qs = new URLSearchParams(location.search);
const NETWORK = qs.get("network") || "local";
const GAS = 300_000_000_000_000n;
const YOCTO = 10n ** 24n;
const UNIT = 10n ** 18n;
// Calls the relayer forwards, so a holder with no NEAR can still make them.
const GASLESS = ["lock", "unlock", "vote", "veto", "veto_tender", "claim_tender"];

let cfg = {};
let chainNow = 0n;
const state = { coins: [], info: {}, offers: {}, tenders: {}, history: {}, decisions: {}, account: {}, keys: {}, params: null, codeHash: null, codeMode: null, brain: null };

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const short = (acct) => String(acct || "").split(".")[0];
const sym = (acct) => state.info[acct]?.symbol || short(acct).toUpperCase();

// ---------- formatting ----------
const fmtTokens = (u) => {
  const n = Number(BigInt(u || 0) / UNIT);
  return Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 2 }).format(n);
};
const fmtNear = (y) => (Number(BigInt(y || 0) / 10n ** 21n) / 1000).toFixed(3) + " Ⓝ";
const fmtRate = (ppm) => (Number(ppm) / 1e6).toFixed(4);
const fmtBps = (b) => (b >= 0 ? "+" : "") + (b / 100).toFixed(1) + "%";
const ago = (ns) => {
  const s = Number((chainNow - BigInt(ns)) / 1_000_000_000n);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
};
const left = (ns) => {
  const s = Number((BigInt(ns) - chainNow) / 1_000_000_000n);
  return s > 0 ? `${s}s left` : "ended";
};
const statusName = (st) => (typeof st === "string" ? st : Object.keys(st || {})[0] || "?");

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

// ---------- load ----------
async function loadConfig() {
  try {
    const r = await fetch(`config.${NETWORK}.json`, { cache: "no-store" });
    if (r.ok) cfg = await r.json();
  } catch (_) {}
  if (qs.get("rpc")) cfg.rpc = qs.get("rpc");
  if (qs.get("launchpad")) cfg.launchpad = qs.get("launchpad");
  if (!cfg.rpc || !cfg.launchpad) {
    $("coins").innerHTML = `<p class="muted">No config for <b>${esc(NETWORK)}</b>. Run <code>cargo run -p autocto-demo</code> and open <code>?network=local</code>, or pass <code>?rpc=…&launchpad=…</code>.</p>`;
    throw new Error("no config");
  }
  $("net-badge").textContent = NETWORK;
  $("launchpad").textContent = cfg.launchpad;
  if (cfg.dev_key && cfg.accounts?.length) {
    $("actor-wrap").hidden = false;
    $("actor").innerHTML = cfg.accounts.map((a) => `<option>${esc(a)}</option>`).join("");
    $("gasless-wrap").hidden = !cfg.relayer;
  }
}

async function refresh() {
  const block = await rpc("block", { finality: "optimistic" });
  chainNow = BigInt(block.header.timestamp_nanosec);
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
  render();
}

// ---------- render ----------
function renderRules() {
  const p = state.params;
  const items = [
    `vote ${p.vote_period_sec}s`, `quorum ${p.quorum_bps / 100}%`, `approval ${p.approval_bps / 100}%`,
    `buyer veto ${p.veto_bps / 100}%`, `premium ≤ ${p.max_premium_bps / 100}%`, `discount ≤ ${p.max_discount_bps / 100}%`,
    `dilution ≤ ${p.max_dilution_bps / 100}%`, `newborn protection ${p.newborn_protection_sec}s`,
    `rebid cooldown ${p.rebid_cooldown_sec}s`, `${p.max_offers_per_day} bids/day`,
    `brain ${fmtNear(p.brain_fee)}/think, ≤ ${fmtNear(p.brain_daily_cap)}/day`, `fee ${p.trade_fee_bps / 100}%`,
    ...(p.tender_threshold_bps ? [`tender: ${p.tender_threshold_bps / 100}% of outside supply in ${p.tender_period_sec}s, mints ≤ ${p.tender_max_dilution_bps / 100}%`] : []),
  ];
  $("rules").innerHTML = items.map((t) => `<span>${esc(t)}</span>`).join("") + `<span>no owner · no setters</span>`;
  $("code-hash").textContent = `coin code ${state.codeHash} · ${typeof state.codeMode === "string" ? state.codeMode : "Global"}`;
}

function coinStatus(info) {
  const st = statusName(info.status);
  if (st === "Merged") return [`merged → ${sym(info.status.Merged.into)}`, "merged"];
  if (st === "MergePending") return ["merge pending", "pending"];
  if (chainNow < BigInt(info.protected_until)) return [`newborn · ${left(info.protected_until)}`, "newborn"];
  return ["open to bids", "active"];
}

function sameCode(a) {
  const acct = state.account[a];
  if (!acct) return null;
  const h = acct.global_contract_hash || acct.code_hash;
  return h === state.codeHash;
}

function renderCoins() {
  $("coins").innerHTML = state.coins.map(({ account_id: a }) => {
    const i = state.info[a];
    const [label, cls] = coinStatus(i);
    // price_yocto is per whole token; show NEAR per 1M tokens (6 decimals kept).
    const price = Number(BigInt(i.price_yocto) * 1_000_000n * 1_000_000n / YOCTO) / 1e6;
    const curveReal = BigInt(i.amm_near) - BigInt(state.params.virtual_near);
    const merged = statusName(i.status) === "Merged";
    const same = sameCode(a);
    return `<article class="card coin">
      <h3><span>$${esc(i.symbol)} <span class="muted small">${esc(i.name)}</span></span><span class="pill ${cls}">${esc(label)}</span></h3>
      <div class="acct mono">${esc(a)}</div>
      <p class="persona">${esc(i.persona)}</p>
      <dl class="stats">
        <dt>price / 1M</dt><dd>${price.toFixed(4)} Ⓝ</dd>
        <dt>circulating</dt><dd>${fmtTokens(i.circulating)}</dd>
        <dt>locked</dt><dd>${fmtTokens(i.total_locked)}</dd>
        <dt>total supply</dt><dd>${fmtTokens(i.total_supply)}</dd>
        ${BigInt(i.owed || 0) > 0n ? `<dt title="still to be minted for holders of coins it absorbed">owed to converters</dt><dd>${fmtTokens(i.owed)}</dd>` : ""}
        <dt>curve NEAR</dt><dd>${fmtNear(curveReal)}</dd>
        <dt>treasury</dt><dd>${fmtNear(i.treasury)}</dd>
        <dt>brain spent</dt><dd>${fmtNear(i.brain_spent_total)}</dd>
        <dt>decisions</dt><dd>${i.decisions}</dd>
      </dl>
      <div class="badges">
        <span class="badge ${state.keys[a] === 0 ? "ok" : "bad"}" title="access keys on the coin account">${state.keys[a] === 0 ? "🔒 0 keys" : `${state.keys[a] ?? "?"} keys`}</span>
        <span class="badge ${same ? "ok" : "bad"}" title="code hash equals the launchpad's coin code">${same ? "✔ launchpad code" : "code ?"}</span>
        ${i.absorbed.map(([t]) => `<span class="badge">ate $${esc(sym(t))}</span>`).join("")}
        ${(i.watchlist || []).map((t) => `<span class="badge" title="outside token nominated by holders for a tender">👀 ${esc(short(t))}</span>`).join("")}
      </div>
      <div class="actions">${merged
        ? `<button data-act="convert" data-coin="${a}">Convert to $${esc(sym(i.status.Merged.into))}</button>`
        : `<button class="primary" data-act="think" data-coin="${a}">🧠 Think</button>
           <button data-act="buy" data-coin="${a}">Buy 1 Ⓝ</button>
           <button data-act="lock" data-coin="${a}">Lock all</button>`}
      </div>
    </article>`;
  }).join("") || `<p class="muted">No coins yet.</p>`;
}

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
  const live = (o) => ["Open", "Executing", "Sending"].includes(statusName(o.status));
  return [...byKey.values()].sort((a, b) => (live(b) - live(a)) || Number(BigInt(b.created_at) - BigInt(a.created_at)));
}

function stanceFor(o) {
  const h = state.history[o.target] || [];
  const s = [...h].reverse().find((e) => e.event === "stance" && e.text.includes(`${o.buyer}#${o.id}`));
  return s ? s.text : null;
}

function renderOffers() {
  const p = state.params;
  const offers = allOffers();
  $("offers").innerHTML = offers.map((o) => {
    const st = statusName(o.status);
    const key = `${o.buyer}#${o.id}`;
    const circ = BigInt(o.target_market?.circulating || 1) || 1n;
    const yes = BigInt(o.yes), no = BigInt(o.no);
    const pct = (x) => Math.min(100, Number((x * 10000n) / circ) / 100);
    const quorum = p.quorum_bps / 100;
    const bcirc = BigInt(o.buyer_market?.circulating || 1) || 1n;
    const vetoPct = Math.min(100, Number((BigInt(o.veto || 0) * 10000n) / bcirc) / 100);
    const open = st === "Open";
    const ended = BigInt(o.vote_ends) <= chainNow;
    const cls = { Open: "active", Executing: "pending", Executed: "merged", Failed: "failed", Sending: "pending" }[st] || "";
    const proposer = o.proposer.Brain ? `🧠 brain decision #${o.proposer.Brain.decision_id}` : `✋ ${esc(o.proposer.Holder?.account_id)}`;
    const stance = stanceFor(o);
    return `<article class="card offer">
      <div class="route">$${esc(sym(o.buyer))} <span class="muted">bids for</span> $${esc(sym(o.target))}
        <span class="pill ${cls}">${esc(st === "Failed" ? "failed: " + o.status.Failed.reason : st.toLowerCase())}</span>
        <span class="muted small">${proposer} · ${ago(o.created_at)}</span></div>
      <div class="terms">
        <span>rate <b>${fmtRate(o.rate_ppm)}</b> $${esc(sym(o.buyer))} per $${esc(sym(o.target))}</span>
        <span>fair <b>${fmtRate(o.fair_rate_ppm)}</b></span>
        <span>premium <b>${fmtBps(o.premium_bps)}</b></span>
        <span>round <b>${o.round}</b></span>
        ${open ? `<span>${left(o.vote_ends)}</span>` : ""}
      </div>
      <div class="pitch"><div class="who">pitch from $${esc(sym(o.buyer))} · untrusted</div>“${esc(o.pitch)}”</div>
      ${o.counter ? `<div class="pitch"><div class="who">counter from $${esc(sym(o.target))}: ${fmtRate(o.counter.rate_ppm)}</div>“${esc(o.counter.pitch)}”</div>` : ""}
      ${stance ? `<div class="pitch"><div class="who">$${esc(sym(o.target))} brain</div>${esc(stance)}</div>` : ""}
      <div>
        <div class="barlabel"><span>yes ${fmtTokens(yes)} · no ${fmtTokens(no)}</span><span>quorum ${quorum}% of ${fmtTokens(circ)}</span></div>
        <div class="bar"><div class="y" style="width:${pct(yes)}%"></div><div class="n" style="left:${pct(yes)}%;width:${pct(no)}%"></div><div class="q" style="left:${quorum}%"></div></div>
      </div>
      <div>
        <div class="barlabel"><span>$${esc(sym(o.buyer))} veto ${fmtTokens(o.veto || 0)}</span><span>blocks at ${p.veto_bps / 100}%</span></div>
        <div class="bar"><div class="n" style="left:0;width:${vetoPct}%"></div><div class="q" style="left:${p.veto_bps / 100}%"></div></div>
      </div>
      <div class="actions">
        ${open && !ended ? `<button class="yes" data-act="vote" data-coin="${o.target}" data-offer="${key}" data-support="true">Vote YES</button>
          <button class="no" data-act="vote" data-coin="${o.target}" data-offer="${key}" data-support="false">Vote NO</button>
          <button data-act="veto" data-coin="${o.buyer}" data-id="${o.id}">Veto (as $${esc(sym(o.buyer))} holder)</button>` : ""}
        ${open && o.counter ? `<button data-act="accept_counter" data-coin="${o.buyer}" data-id="${o.id}">Accept counter</button>` : ""}
        ${open && ended ? `<button class="primary" data-act="finalize" data-coin="${o.target}" data-offer="${key}">Finalize</button>` : ""}
      </div>
    </article>`;
  }).join("") || (Object.values(state.tenders).some((l) => l.length) ? "" : `<p class="muted">No bids yet. Press 🧠 Think on a coin.</p>`);
}

// Tender offers for tokens from outside the launchpad: deposits are the vote.
function renderTenders() {
  const p = state.params;
  const rows = [];
  for (const [coin, list] of Object.entries(state.tenders)) for (const t of list) rows.push({ coin, t });
  rows.sort((a, b) => Number(BigInt(b.t.created_at) - BigInt(a.t.created_at)));
  $("tenders").innerHTML = rows.map(({ coin, t }) => {
    const st = statusName(t.status);
    const cap = BigInt(t.max_deposit) || 1n;
    const pct = (x) => Math.min(100, Number((BigInt(x) * 10000n) / cap) / 100);
    const supply = BigInt(t.token_supply) || 1n;
    const share = (x) => (Number((BigInt(x) * 10000n) / supply) / 100).toFixed(1) + "%";
    const bsupply = BigInt(t.buyer_supply) || 1n;
    const vetoPct = Math.min(100, Number((BigInt(t.veto) * 10000n) / bsupply) / 100);
    const open = st === "Open";
    const ended = open && BigInt(t.deadline) <= chainNow;
    const cls = { Open: "active", Opening: "pending", Succeeded: "merged", Failed: "failed" }[st] || "";
    const proposer = t.proposer.Brain ? `🧠 brain decision #${t.proposer.Brain.decision_id}` : `✋ ${esc(t.proposer.Holder?.account_id)}`;
    return `<article class="card offer">
      <div class="route">$${esc(sym(coin))} <span class="muted">tenders for outside token</span> <span class="mono">${esc(t.token)}</span>
        <span class="pill ${cls}">${esc(st === "Failed" ? "failed: " + t.status.Failed.reason : st.toLowerCase())}</span>
        <span class="muted small">${proposer} · ${ago(t.created_at)}</span></div>
      <div class="terms">
        <span>rate <b>${fmtRate(t.rate_ppm)}</b> $${esc(sym(coin))} per token</span>
        <span>all or nothing at <b>${share(t.threshold)}</b> of its supply</span>
        ${open && !ended ? `<span>${left(t.deadline)}</span>` : ""}
      </div>
      <div class="pitch"><div class="who">pitch from $${esc(sym(coin))}</div>“${esc(t.pitch)}”</div>
      <div>
        <div class="barlabel"><span>deposited ${share(t.deposited)} of supply</span><span>needs ${share(t.threshold)} · cap ${share(t.max_deposit)}</span></div>
        <div class="bar"><div class="y" style="width:${pct(t.deposited)}%"></div><div class="q" style="left:${pct(t.threshold)}%"></div></div>
      </div>
      <div>
        <div class="barlabel"><span>$${esc(sym(coin))} veto ${fmtTokens(t.veto)}</span><span>blocks at ${p.veto_bps / 100}%</span></div>
        <div class="bar"><div class="n" style="left:0;width:${vetoPct}%"></div><div class="q" style="left:${p.veto_bps / 100}%"></div></div>
      </div>
      <div class="actions">
        ${open && !ended ? `<button data-act="veto_tender" data-coin="${coin}" data-id="${t.id}">Veto (as $${esc(sym(coin))} holder)</button>` : ""}
        ${ended ? `<button class="primary" data-act="settle_tender" data-coin="${coin}" data-id="${t.id}">Settle</button>` : ""}
        ${st === "Succeeded" || st === "Failed" ? `<button data-act="claim_tender" data-coin="${coin}" data-id="${t.id}">${st === "Succeeded" ? "Claim $" + esc(sym(coin)) : "Claim refund"}</button>` : ""}
      </div>
    </article>`;
  }).join("");
}

function renderDecisions() {
  const rows = [];
  for (const [coin, list] of Object.entries(state.decisions)) for (const d of list) rows.push({ coin, d });
  rows.sort((a, b) => Number(BigInt(b.d.requested_at) - BigInt(a.d.requested_at)));
  $("decisions").innerHTML = rows.slice(0, 20).map(({ coin, d }) => {
    let out = null;
    try { out = JSON.parse(d.output); } catch (_) {}
    const st = statusName(d.status);
    const cls = { Applied: "active", Pending: "pending", Refused: "failed", NoAnswer: "failed" }[st];
    return `<div class="card decision">
      <div class="head"><b>$${esc(sym(coin))} #${d.id}</b><span class="pill ${cls}">${esc(st === "Refused" ? "refused: " + d.status.Refused.reason : st)}</span></div>
      ${out ? `<div class="thought">${esc(out.thought)}</div><div class="mono small muted">${esc(JSON.stringify(out.action))}</div>` : ""}
      <div class="small muted">${ago(d.requested_at)} · ${out?.mode ? esc(out.mode) + " · " : ""}paid ${fmtNear(d.paid)} by ${d.paid_by_treasury ? "treasury" : esc(d.requested_by)}
        · <a href="#" data-verify="${coin}|${d.id}">verify this decision</a></div>
    </div>`;
  }).join("") || `<p class="muted">No brain runs yet.</p>`;
}

function renderLog() {
  const all = [];
  for (const [coin, h] of Object.entries(state.history)) for (const e of h) all.push({ coin, ...e });
  all.sort((a, b) => Number(BigInt(b.at) - BigInt(a.at)));
  $("log").innerHTML = all.slice(0, 120).map((e) =>
    `<li><span class="when">${ago(e.at)}</span><span class="ev">$${esc(sym(e.coin))} ${esc(e.event)}</span>${esc(e.text)}</li>`).join("");
}

function render() {
  renderCoins(); renderOffers(); renderTenders(); renderDecisions(); renderLog();
}

// ---------- verify ----------
function showVerify(coin, id) {
  const d = state.decisions[coin].find((x) => String(x.id) === id);
  const explorer = cfg.explorer ? `${cfg.explorer}/address/${coin}` : null;
  $("modal-body").innerHTML = `<h3>Verify decision #${d.id} of $${esc(sym(coin))}</h3>
    <p>When <code>think()</code> ran, the coin hashed the exact input it handed to OutLayer and stored it on-chain:</p>
    <pre>input_sha256 = ${esc(d.input_sha256)}</pre>
    <p>OutLayer runs the brain pinned at launch (<code>get_brain</code> on any coin shows the source and wasm hash) inside an Intel TDX worker whose key is registered from a TDX quote.
      The worker's attestation commits to the code hash, this input hash and the output, and the answer can only reach the coin as the callback of its own call to <code>${esc(state.brain.outlayer)}</code>.</p>
    <pre>brain source (fixed at launch): ${esc(state.brain.source)}</pre>
    <p>The answer the contract received, and what it did with it:</p>
    <pre>${esc(d.output || "(none)")}</pre>
    <pre>status: ${esc(JSON.stringify(d.status))}</pre>
    <p class="small">Check: ${explorer ? `<a href="${explorer}" target="_blank" rel="noopener">coin transactions</a> (the <code>on_brain</code> receipt), ` : ""}
      <a href="https://app.outlayer.ai/workspace" target="_blank" rel="noopener">OutLayer executions</a>.
      ${NETWORK === "local" ? "Locally, the mock OutLayer logs <code>execution_resolved</code> with the same input_sha256 and the output's sha256." : ""}</p>`;
  $("modal").showModal();
}

// ---------- actions ----------
let nearApi = null;
async function act(btn) {
  const { act: what, coin, offer, support, id } = btn.dataset;
  const plans = {
    launch: async () => {
      const f = Object.fromEntries(new FormData($("launch-form")));
      if (!/^[a-z0-9_-]{2,32}$/.test(f.label)) throw new Error("label: 2-32 of a-z 0-9 - _");
      const min = BigInt(await view(cfg.launchpad, "min_launch_deposit"));
      const args = { label: f.label, name: f.name, symbol: f.symbol.toUpperCase(), icon: null, persona: f.persona };
      return ["launch", args, min + YOCTO, cfg.launchpad];
    },
    think: () => ["think", {}, 10n ** 23n],
    buy: () => ["buy", {}, YOCTO],
    lock: async () => ["lock", { amount: await view(coin, "ft_balance_of", { account_id: actor() }) }, 0n],
    vote: () => ["vote", { offer, support: support === "true" }, 0n],
    veto: () => ["veto", { offer_id: Number(id) }, 0n],
    finalize: () => ["finalize", { offer }, 0n],
    accept_counter: () => ["accept_counter", { offer_id: Number(id) }, 0n],
    convert: () => ["convert", {}, 1n],
    veto_tender: () => ["veto_tender", { tender_id: Number(id) }, 0n],
    settle_tender: () => ["settle_tender", { tender_id: Number(id) }, 0n],
    claim_tender: () => ["claim_tender", { tender_id: Number(id) }, 0n],
  };
  let plan;
  try { plan = await plans[what](); } catch (e) { toast(`${what} ✘ ${e.message || e}`); return; }
  let [method, args, deposit, contract = coin] = plan;
  if (!cfg.dev_key) {
    const near = (Number(deposit / 10n ** 18n) / 1e6).toString();
    $("modal-body").innerHTML = `<h3>${esc(method)} on ${esc(contract)}</h3><p>Sign this with <a href="https://github.com/near/near-cli-rs">near-cli</a>:</p>
      <pre>near contract call-function as-transaction ${esc(contract)} ${esc(method)} json-args '${esc(JSON.stringify(args))}' prepaid-gas '300 Tgas' attached-deposit '${near} NEAR' sign-as &lt;you&gt;.testnet network-config testnet sign-with-legacy-keychain send</pre>`;
    $("modal").showModal();
    return;
  }
  btn.disabled = true;
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
    toast(`${method} ✔ ${r == null ? "" : JSON.stringify(r).slice(0, 80)}`);
  } catch (e) {
    toast(`${method} ✘ ${String(e.message || e).slice(0, 160)}`);
  } finally {
    btn.disabled = false;
    refresh().catch(() => {});
  }
}
const actor = () => $("actor").value;
let toastTimer;
function toast(t) {
  $("toast").textContent = t; $("toast").hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => ($("toast").hidden = true), 5000);
}

document.addEventListener("click", (e) => {
  const v = e.target.closest("[data-verify]");
  if (v) { e.preventDefault(); const [c, i] = v.dataset.verify.split("|"); showVerify(c, i); return; }
  const b = e.target.closest("button[data-act]");
  if (b) { e.preventDefault(); act(b); }
});
$("launch-form").addEventListener("submit", (e) => {
  e.preventDefault();
  act(e.target.querySelector("button[data-act]"));
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
  const colors = ["#5b3df5", "#1f9d55", "#d64545", "#c98a00", "#0e8fb3", "#a33ea1"];
  $("sim").innerHTML = sim.scenarios.map((s) => {
    const W = 340, H = 170, P = 28;
    const series = Object.entries(s.supply);
    const maxY = Math.max(1, ...series.flatMap(([, v]) => v));
    const days = series[0][1].length - 1;
    const x = (d) => P + (d / days) * (W - P - 8);
    const y = (v) => H - 20 - (v / maxY) * (H - 34);
    const lines = series.map(([, v], k) =>
      `<polyline fill="none" stroke="${colors[k % colors.length]}" stroke-width="2" points="${v.map((p, d) => `${x(d).toFixed(1)},${y(p).toFixed(1)}`).join(" ")}"/>`).join("");
    const legend = series.map(([name], k) => `<span><i style="background:${colors[k % colors.length]}"></i>${esc(name)}</span>`).join("");
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
    return `<td class="${chosen ? "chosen" : ""}${r.attackBadPasses ? " bad" : ""}" title="score ${r.score}">
      ${Math.round(r.goodPassRate * 100)}% / ${Math.round(r.badPassRate * 100)}%${r.attackBadPasses ? ` (${r.attackBadPasses} attacks won)` : ""}</td>`;
  };
  const body = rows.map((key) => {
    const [q, a] = key.split("|").map(Number);
    const cells = vetos.map((v) => sim.sweep.find((r) => r.quorumBps === q && r.approvalBps === a && r.vetoBps === v)).map((r) => (r ? cell(r) : "<td></td>")).join("");
    return `<tr><th>${pct(q)}</th><th>${pct(a)}</th>${cells}</tr>`;
  }).join("");
  return `<p class="muted small">Each cell: good deals that pass / bad deals that pass, over ${sim.chosen.attacks} whale attacks per row.
    Chosen: the most conservative row within 0.05 of the best score, <b>quorum ${pct(c.quorumBps)}, approval ${pct(c.approvalBps)}, buyer veto ${pct(c.vetoBps)}</b>.</p>
    <div class="scroll"><table class="sweep"><thead><tr><th>quorum</th><th>approval</th>${vetos.map((v) => `<th>veto ${pct(v)}</th>`).join("")}</tr></thead><tbody>${body}</tbody></table></div>`;
}

// ---------- boot ----------
// The badge says when the chain stops answering (e.g. the local demo was stopped).
async function tick() {
  try {
    await refresh();
    $("net-badge").textContent = NETWORK;
    $("net-badge").className = "pill";
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
