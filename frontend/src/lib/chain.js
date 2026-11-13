// KillerCoins chain layer: reads every coin straight from NEAR RPC and sends actions. No backend.
// ?network=local   -> config.local.json (written by `cargo run -p autocto-demo`)
// ?network=testnet -> config.testnet.json (written by `cargo run -p autocto-demo --bin deploy`)
// Without it: local on localhost, testnet anywhere else. ?rpc=...&launchpad=... override either.
import { useSyncExternalStore } from "react";
import { toast } from "sonner";
import { NETWORK } from "@/lib/utils";

export { NETWORK };
const qs = new URLSearchParams(location.search);
const GAS = 300_000_000_000_000n;
export const YOCTO = 10n ** 24n;
export const UNIT = 10n ** 18n;
export const NS = 1_000_000_000n;
// Calls the relayer forwards, so a holder with no NEAR can still make them.
const GASLESS = ["lock", "unlock", "vote", "vote_sealed", "reveal_vote", "veto", "veto_tender", "back_tender", "claim_tender"];
const NEAR_API = "https://cdn.jsdelivr.net/npm/near-api-js@7.4.0/+esm";
const NEAR_CONNECT = "https://cdn.jsdelivr.net/npm/@hot-labs/near-connect@0.12.0/+esm";

export let cfg = {};
let chainNow = 0n, loadedAt = Date.now();
export const state = {
  ready: false, online: null, noConfig: false,
  coins: [], info: {}, offers: {}, tenders: {}, history: {}, decisions: {}, account: {}, keys: {},
  params: null, codeHash: null, codeMode: null, brain: null, launchMin: null,
  // the signed-in (or viewed) account: balances and locks per coin
  me: { acct: "", near: null, bal: {}, locks: {}, until: {}, registered: {} },
  storageMin: {},
  // price samples taken by this page while it is open: there is no price-history view
  samples: {}, opened: Date.now(),
  sel: null, actor: "", wallet: null, gasless: false, acting: false,
  // a guest account this browser holds the key to, and whether the host hands them out ({ near } when it does)
  guest: null, guestOffer: null,
  dialog: null, // { type: "cli" | "salt" | "signin", ... } for the page to show
  auto: null, // the demo's "play a takeover" run: { running, steps: [{ text, done }], error, until }
};

// ---------- store ----------
let version = 0;
const subs = new Set();
export function bump() { version++; for (const f of subs) f(); }
const subscribe = (f) => { subs.add(f); return () => subs.delete(f); };
/** Re-renders the caller whenever the chain state or a selection changes. */
export const useChain = () => useSyncExternalStore(subscribe, () => version);
/** Chain time, moved forward by the wall clock since the last block was read. */
export const now = () => chainNow + BigInt(Date.now() - loadedAt) * 1_000_000n;

export const store = {
  get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); return true; } catch (_) { return false; } },
  del(k) { try { localStorage.removeItem(k); } catch (_) {} },
};

// ---------- words explained ----------
export const GLOSSARY = {
  "bonding curve": "The coin's built-in market. You always buy from it and sell back to it, so there is always a price. Every buy pushes the price up, every sell pushes it down.",
  lock: "Setting tokens aside so they count as votes. They stay yours and you can unlock them later. Only tokens locked before a bid was announced count for that bid.",
  held: "Once you vote, veto or bid by hand, your locked tokens can't be unlocked until that vote ends, so nobody can vote and then sell. A bid by hand holds them for the whole vote period, even if the target refuses it.",
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

// ---------- formatting ----------
export const short = (acct) => String(acct || "").split(".")[0];
export const sym = (acct) => state.info[acct]?.symbol || short(acct).toUpperCase();
export const compact = (n, d = 2) => Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: d }).format(n);
export const tokNum = (u) => Number(BigInt(u || 0) / 10n ** 12n) / 1e6;
export const nearNum = (y) => Number(BigInt(y || 0) / 10n ** 18n) / 1e6;
export const fmtTokens = (u) => compact(Number(BigInt(u || 0) / UNIT));
export const fmtNear = (y) => {
  const n = nearNum(y);
  return (Math.abs(n) >= 1e5 ? compact(n) : n.toLocaleString("en", { minimumFractionDigits: 3, maximumFractionDigits: 3 })) + " Ⓝ";
};
// A small positive number with 4 significant digits and no exponent.
export const fmtSig = (n) => {
  if (!(n > 0) || !isFinite(n)) return "0";
  const d = Math.max(0, 3 - Math.floor(Math.log10(n)));
  return d > 20 ? n.toExponential(3) : n.toFixed(d);
};
// price_yocto is yoctoNEAR per whole token.
export const priceNum = (i) => Number(BigInt(i.price_yocto)) / 1e24;
// A single token costs a tiny fraction of a NEAR, so prices are shown per 1M tokens.
export const fmtPrice = (p) => `${fmtSig(p * 1e6)} Ⓝ`;
export const fmtRate = (ppm) => (Number(ppm) / 1e6).toFixed(4);
export const fmtBps = (b) => (b >= 0 ? "+" : "") + (b / 100).toFixed(1) + "%";
export const fmtPct = (x) => (x >= 0 ? "+" : "") + (x * 100).toFixed(Math.abs(x) < 0.1 ? 2 : 1) + "%";
export const ago = (ns) => {
  const s = Math.max(0, Number((now() - BigInt(ns)) / NS));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
};
export const left = (ns) => {
  const s = Number((BigInt(ns) - now()) / NS);
  if (s <= 0) return "ended";
  if (s < 120) return `${s}s left`;
  if (s < 7200) return `${Math.floor(s / 60)}m ${s % 60}s left`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m left`;
};
export const mins = (sec) => (sec % 3600 === 0 ? `${sec / 3600} h` : sec >= 120 ? `${Math.round(sec / 60)} min` : `${sec} s`);
export const statusName = (st) => (typeof st === "string" ? st : Object.keys(st || {})[0] || "?");
export const hue = (s) => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };

// Contract texts carry raw integers and account ids: make them readable.
export function humanize(text) {
  let t = String(text ?? "");
  // The contract can't see the target's reason from the buyer's side; the page says what it means.
  t = t.replace("the target refused the bid (see its logs)", "the target turned it away on arrival, so no vote was held");
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
// The panic of a receipt that failed inside a transaction that itself went through.
function refusalIn(out) {
  const r = out?.receipts_outcome?.find((x) => x.outcome?.status?.Failure);
  return r ? plainError(JSON.stringify(r.outcome.status.Failure)) : null;
}

// Decimal text <-> integer units, exact.
export function parseUnits(text, dec) {
  const s = String(text).trim().replace(/[,\s_]/g, "");
  if (!/^(\d+\.?\d*|\.\d+)$/.test(s)) return null;
  const [i, f = ""] = s.split(".");
  return BigInt(i || "0") * 10n ** BigInt(dec) + BigInt(f.slice(0, dec).padEnd(dec, "0") || "0");
}
export function fmtUnits(v, dec) {
  const s = BigInt(v).toString().padStart(dec + 1, "0");
  const f = s.slice(-dec).replace(/0+$/, "");
  return f ? `${s.slice(0, -dec)}.${f}` : s.slice(0, -dec);
}

// ---------- derived ----------
export const curveReal = (i) => { const r = BigInt(i.amm_near) - BigInt(state.params.virtual_near); return r > 0n ? r : 0n; };
export const marketCap = (i) => (BigInt(i.price_yocto) * BigInt(i.circulating)) / UNIT;
export const isMerged = (i) => statusName(i.status) === "Merged";
export const liveOffer = (o) => ["Open", "Executing", "Sending"].includes(statusName(o.status));
export const lockedOf = (a) => (state.me.locks[a] || []).reduce((s, l) => s + BigInt(l.amount), 0n);
export const modeDec = (mode) => (mode === "buy" ? 24 : 18);
export function available(mode, a) {
  if (!state.me.acct) return null;
  if (mode === "buy") return state.me.near;
  if (mode === "unlock") return lockedOf(a);
  return state.me.bal[a] ?? null;
}
export function sameCode(a) {
  const acct = state.account[a];
  if (!acct) return null;
  return (acct.global_contract_hash || acct.code_hash) === state.codeHash;
}
export function sessionChange(a) {
  const s = state.samples[a] || [];
  if (s.length < 2 || !(s[0].p > 0)) return null;
  return s[s.length - 1].p / s[0].p - 1;
}
/** [label, tone, countdown-until?] for a coin's status pill. */
export function coinStatus(info) {
  const st = statusName(info.status);
  if (st === "Merged") return [`absorbed by $${sym(info.status.Merged.into)}`, "muted"];
  if (st === "MergePending") return ["merging…", "brand"];
  if (now() < BigInt(info.protected_until)) return ["newborn", "warn", info.protected_until];
  return ["trading", "up"];
}
export function allOffers() {
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
export function stanceFor(o) {
  const h = state.history[o.target] || [];
  const s = [...h].reverse().find((e) => e.event === "stance" && e.text.includes(`${o.buyer}#${o.id}`));
  return s ? s.text : null;
}
// What a brain's answer means, in a sentence.
export function describeAction(coin, a) {
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

// ---------- rpc ----------
// Public nodes limit how often one visitor may ask. When one refuses, the page moves to the next.
const SPARE_RPC = {
  testnet: ["https://test.rpc.fastnear.com", "https://rpc.testnet.fastnear.com", "https://near-testnet.drpc.org"],
  mainnet: ["https://free.rpc.fastnear.com", "https://rpc.mainnet.fastnear.com", "https://near.drpc.org"],
};
const same = (a, b) => a.replace(/\/$/, "") === b.replace(/\/$/, "");
// At most four questions in the air at once, so a refresh is not one burst.
let flying = 0;
const waiting = [];
async function slot() {
  if (flying >= 4) await new Promise((go) => waiting.push(go));
  flying++;
}
const done = () => { flying--; waiting.shift()?.(); };
export async function rpc(method, params) {
  await slot();
  try { return await ask(method, params); } finally { done(); }
}
const rpcNodes = () => [cfg.rpc, ...(qs.get("rpc") ? [] : SPARE_RPC[NETWORK] || []).filter((u) => !same(u, cfg.rpc))];
const NODE_TROUBLE = /INTERNAL_ERROR|TIMEOUT_ERROR|NO_SYNCED_BLOCKS|NODE_IS_SYNCING|NOT_SYNCED_YET|UNAVAILABLE_SHARD/;
// near-api-js's words for a node that failed to answer, as opposed to the chain refusing the call.
const NO_ANSWER = /Internal server error|Timeout error|Bad Gateway|unavailable|Transaction timed out|Node is syncing|not synced|No new blocks|Exceeded \d+ attempts|Failed to fetch|FetchError|NetworkError|Load failed/i;
const noAnswer = (e) => typeof e?.cause === "number" || NO_ANSWER.test(String(e?.message || e));
/**
 * For signing: one near-api-js provider that moves to the next node when a node fails to
 * answer, after one retry there. A send is the same signed transaction on every node, so the
 * chain runs it at most once. The chain's own refusals pass straight through.
 */
function sendProvider() {
  const each = rpcNodes().map((url) => new nearApi.JsonRpcProvider({ url }, { retries: 2, wait: 700, backoff: 1.5 }));
  class Spare extends nearApi.JsonRpcProvider {
    async sendJsonRpc(method, params) {
      let last;
      for (const p of each) {
        try { return await p.sendJsonRpc(method, params); } catch (e) { if (!noAnswer(e)) throw e; last = e; }
      }
      throw last;
    }
  }
  return new Spare({ url: cfg.rpc });
}
async function ask(method, params) {
  let last;
  // Two rounds: a node that said "too many requests" usually answers again a moment later.
  for (const url of [...rpcNodes(), null, ...rpcNodes()]) {
    if (!url) { await new Promise((r) => setTimeout(r, 1500)); continue; }
    try {
      const r = await fetch(url, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "page", method, params }),
      });
      if (!r.ok) throw new Error(`${new URL(url).host} answered ${r.status}`);
      const j = await r.json();
      // A node's own trouble (internal error, timeout, still syncing) is worth asking the next one.
      if (j.error && NODE_TROUBLE.test(JSON.stringify(j.error))) throw new Error(`${new URL(url).host}: ${JSON.stringify(j.error).slice(0, 120)}`);
      if (j.error) return Promise.reject(new Error(JSON.stringify(j.error)));
      cfg.rpc = url; // stay with the node that answered
      return j.result;
    } catch (e) { last = e; }
  }
  throw last;
}
export async function view(account, method, args = {}) {
  const res = await rpc("query", {
    request_type: "call_function", finality: "optimistic", account_id: account,
    method_name: method, args_base64: btoa(JSON.stringify(args)),
  });
  return JSON.parse(new TextDecoder().decode(new Uint8Array(res.result)));
}

// ---------- load ----------
export const hasWallet = () => !cfg.dev_key && (NETWORK === "testnet" || NETWORK === "mainnet");

async function loadConfig() {
  try {
    const r = await fetch(`config.${NETWORK}.json`, { cache: "no-store" });
    if (r.ok) cfg = await r.json();
  } catch (_) {}
  if (qs.get("rpc")) cfg.rpc = qs.get("rpc");
  if (qs.get("launchpad")) cfg.launchpad = qs.get("launchpad");
  if (!cfg.rpc || !cfg.launchpad) { state.noConfig = true; bump(); throw new Error("no config"); }
  if (cfg.dev_key && cfg.accounts?.length) {
    const saved = store.get(`autocto:actor:${cfg.launchpad}`);
    state.actor = saved && cfg.accounts.includes(saved) ? saved : cfg.accounts[0];
  } else {
    // No dev key: an account can be typed to see its balances; a wallet or a guest key signs.
    state.actor = store.get(`autocto:viewer:${NETWORK}`) || "";
    if (hasWallet()) { loadGuest(); restoreWallet(); offerGuest(); }
  }
  state.sel = store.get(`autocto:coin:${cfg.launchpad}`);
}

async function loadUser() {
  const who = state.actor;
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
  chainNow = BigInt(block.header.timestamp_nanosec); loadedAt = Date.now();
  if (!state.params) {
    [state.params, state.codeHash, state.codeMode, state.brain] = await Promise.all([
      view(cfg.launchpad, "get_params"), view(cfg.launchpad, "coin_code_hash"), view(cfg.launchpad, "get_code_mode"),
      view(cfg.launchpad, "get_brain"),
    ]);
    state.launchMin = BigInt(await view(cfg.launchpad, "min_launch_deposit"));
  }
  state.coins = (await view(cfg.launchpad, "list_coins", { limit: 100 })).filter((c) => c.state === "Live");
  tick++;
  await Promise.all(state.coins.map(async ({ account_id: a }) => {
    // A merged coin only changes when someone converts: look at it less often.
    if (state.info[a] && isMerged(state.info[a]) && tick % 6) return;
    const [info, offers, history, decisions, tenders, acct, keys] = await Promise.all([
      view(a, "coin_info"), view(a, "list_offers"), view(a, "history"), view(a, "list_decisions", { limit: 12 }),
      view(a, "list_tenders").catch(() => []),
      // An account with no keys can never get one or change its code: ask once.
      state.keys[a] === 0 ? state.account[a] : rpc("query", { request_type: "view_account", finality: "optimistic", account_id: a }).catch(() => null),
      state.keys[a] === 0 ? { keys: [] } : rpc("query", { request_type: "view_access_key_list", finality: "optimistic", account_id: a }).catch(() => null),
    ]);
    state.info[a] = info;
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
  state.ready = true;
}

let busy = false, again = false, tick = 0;
export async function refresh() {
  if (busy) { again = true; return; }
  busy = true;
  try { await load(); state.online = true; }
  catch (e) { state.online = false; console.warn(e); }
  finally {
    busy = false; bump();
    if (again) { again = false; refresh(); }
  }
}

let started = false;
export function start() {
  if (started) return;
  started = true;
  // A local chain can be asked as often as we like; a public node cannot.
  const every = cfg => (cfg.dev_key ? 3000 : 10000);
  loadConfig().then(() => {
    refresh();
    setInterval(() => { if (!document.hidden) refresh(); }, every(cfg));
    document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
  }).catch((e) => console.warn(e));
}

export function selectCoin(a) {
  if (!state.info[a] || a === state.sel) return;
  state.sel = a;
  store.set(`autocto:coin:${cfg.launchpad}`, a);
  bump(); refresh();
}
export function setActor(a) {
  state.actor = a;
  store.set(cfg.dev_key ? `autocto:actor:${cfg.launchpad}` : `autocto:viewer:${NETWORK}`, a);
  bump(); refresh();
}
export function setGasless(on) { state.gasless = on; bump(); }
export function closeDialog() { state.dialog = null; bump(); }

// ---------- quotes ----------
// Live quote straight from the coin's views. `eff` is the NEAR that reaches the curve.
export async function fetchQuote(mode, a, amount) {
  if (mode === "buy") {
    const eff = state.me.registered[a] === false ? amount - (state.storageMin[a] || 0n) : amount;
    if (eff <= 0n) throw new Error("too small: a first buy also pays for token storage");
    return { mode, coin: a, amount, eff, out: BigInt(await view(a, "quote_buy", { near: eff.toString() })) };
  }
  return { mode, coin: a, amount, eff: 0n, out: BigInt(await view(a, "quote_sell", { tokens: amount.toString() })) };
}
export const minOut = (out, slipBps) => (out * (10000n - BigInt(slipBps))) / 10000n;

// ---------- sealed ballots ----------
// The salt and the choice stay in this browser until the reveal.
const memBallots = new Map();
const ballotKey = (offer, round, acct) => `autocto:ballot:${cfg.launchpad}:${offer}|${round}|${acct}`;
export function getBallot(offer, round, acct) {
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

// ---------- wallet (testnet, mainnet) ----------
// NEAR Connect shows the wallet picker and passes transactions to the chosen wallet,
// which runs in its own sandboxed frame. Keys never touch this page.
let connector = null;
function setWallet(acct) {
  state.wallet = acct || null;
  if (acct) setActor(acct); else if (guest) setActor(guest.account); else bump();
}
async function getConnector() {
  if (connector) return connector;
  const { NearConnector } = await import(/* @vite-ignore */ NEAR_CONNECT);
  connector = new NearConnector({ network: NETWORK });
  connector.on("wallet:signIn", (t) => { setWallet(t.accounts?.[0]?.accountId); if (state.wallet) toast.success(`Connected as ${state.wallet}`); });
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
export async function connectWallet() {
  try {
    const c = await getConnector();
    if (state.wallet) await c.disconnect(); else await c.connect();
  } catch (e) {
    // Closing the picker is not an error worth a message.
    if (!/reject|cancel|closed/i.test(String(e?.message || e))) toast.error(`Could not open the wallet: ${e?.message || e}`);
  }
}
// ---------- guest accounts (testnet) ----------
// For visitors with no wallet: the page makes a key pair, and the host's api/guest creates
// <random>.<its account> for the public half, with a little test NEAR. The key stays in this browser
// and signs here, like the local demo's. Lose the browser's data and the guest is gone.
let guest = null;
const guestKey = () => `autocto:guest:${NETWORK}`;
function loadGuest() {
  try {
    const g = JSON.parse(store.get(guestKey()));
    if (typeof g?.account === "string" && typeof g?.key === "string") { guest = g; state.guest = g.account; state.actor = g.account; }
  } catch (_) {}
}
// The host says whether it hands out guests. A plain static host has no such endpoint, and nothing shows.
function offerGuest() {
  fetch("api/guest", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null))
    .then((j) => { if (j?.enabled) { state.guestOffer = { near: j.near }; bump(); } }).catch(() => {});
}
export async function startGuest() {
  if (state.acting || guest) return false;
  state.acting = true; bump();
  const tid = toast.loading("Making you a guest account on testnet…");
  try {
    nearApi ??= await import(/* @vite-ignore */ NEAR_API);
    const pair = nearApi.KeyPair.fromRandom("ed25519");
    const r = await fetch("api/guest", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ public_key: pair.getPublicKey().toString() }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.account) throw new Error(j.error || `the host answered ${r.status}`);
    guest = { account: j.account, key: pair.toString() };
    const kept = store.set(guestKey(), JSON.stringify(guest));
    state.guest = guest.account;
    toast.success(`You're ${short(guest.account)}, with ${j.near} test NEAR.${kept ? "" : " This browser won't keep the key, so the account lasts until you close the tab."}`, { id: tid });
    if (!state.wallet) setActor(guest.account);
    return true;
  } catch (e) {
    toast.error(`No guest account: ${e.message || e}`, { id: tid });
    return false;
  } finally {
    state.acting = false; bump();
  }
}
/** Forget the guest. Its account stays on chain, but nobody holds its key any more. */
export function endGuest() {
  guest = null; state.guest = null; store.del(guestKey());
  if (!state.wallet) setActor("");
}

async function walletCall(contract, method, args, deposit) {
  const c = await getConnector();
  const wallet = await c.wallet();
  const outcome = await wallet.signAndSendTransaction({
    receiverId: contract,
    actions: [{ type: "FunctionCall", params: { methodName: method, args, gas: GAS.toString(), deposit: BigInt(deposit).toString() } }],
  });
  // Some wallets resolve even when the contract refused the call. Only the
  // transaction's own status counts: a callback can fail and be handled.
  const failure = outcome?.status?.Failure;
  if (failure) throw new Error(JSON.stringify(failure));
  return outcome;
}

// ---------- actions ----------
// What each action is called while it runs and once it is done.
const SAY = {
  launch: ["Launching your coin", "Your coin is live. It shows up in the market in a moment."],
  think: ["Waking the brain", "The brain is thinking. OutLayer usually answers within 2 minutes; the decision appears under Brains."],
  buy: ["Buying", "Bought. The tokens are in your wallet."],
  sell: ["Selling", "Sold. The NEAR is in your wallet."],
  lock: ["Locking", "Locked. These tokens now count in votes on bids announced from here on."],
  unlock: ["Unlocking", "Unlocked. You can sell these tokens again."],
  vote: ["Casting your vote", "Your vote is in."],
  reveal: ["Revealing your vote", "Your vote is revealed and counted."],
  veto: ["Sending your veto", "Your veto is in."],
  finalize: ["Counting the votes", "The vote is counted. See the deal for the result."],
  propose: ["Sending your bid", "Bid sent. If the target accepts it, the vote opens under Deals."],
  accept_counter: ["Accepting the counter-offer", "Counter-offer accepted. A new voting round starts."],
  convert: ["Converting", "Converted. You now hold the winning coin."],
  back_tender: ["Backing the tender", "You backed this tender."],
  veto_tender: ["Sending your veto", "Your veto is in."],
  settle_tender: ["Settling the tender", "The tender is settled."],
  claim_tender: ["Claiming", "Claimed. Check your wallet."],
};
let nearApi = null;

/**
 * Run one action. `d` carries what the action needs: coin, offer, round, support, id,
 * amount (decimal text), slip (bps), form (launch fields). Resolves true when it went through.
 */
export async function act(what, d = {}) {
  const { coin, offer, support, id, round } = d;
  const amount = (dec) => {
    const v = parseUnits(d.amount ?? "", dec);
    if (v == null || v === 0n) throw new Error("Enter a positive amount.");
    return v;
  };
  const slip = d.slip ?? 100;
  // A plan is [method, args, deposit, contract?, { fail }?].
  const plans = {
    launch: async () => {
      const f = d.form;
      if (!/^[a-z0-9_-]{2,32}$/.test(f.label)) throw new Error("Address: 2 to 32 of a-z, 0-9, - and _");
      const min = BigInt(await view(cfg.launchpad, "min_launch_deposit"));
      return ["launch", { label: f.label, name: f.name.trim(), symbol: f.symbol.toUpperCase(), icon: f.icon || null, persona: f.persona.trim() }, min + YOCTO, cfg.launchpad];
    },
    // Exactly the fee shown next to the button: the contract forwards all of it to OutLayer.
    think: async () => ["think", {}, BigInt((state.params || await view(coin, "get_params")).brain_fee)],
    // Buy and sell re-quote right before signing and pass min_out, so a moved price is refused by the contract.
    buy: async () => {
      const near = amount(24);
      const q = await fetchQuote("buy", coin, near);
      return ["buy", { min_out: minOut(q.out, slip).toString() }, near];
    },
    sell: async () => {
      const tokens = amount(18);
      const q = await fetchQuote("sell", coin, tokens);
      return ["sell", { amount: tokens.toString(), min_out: minOut(q.out, slip).toString() }, 1n];
    },
    lock: () => ["lock", { amount: amount(18).toString() }, 0n],
    unlock: () => ["unlock", { amount: amount(18).toString() }, 0n],
    vote: async () => {
      if (!(state.params.reveal_period_sec > 0)) return ["vote", { offer, support }, 0n];
      // Sealed vote: commit to sha256("offer|round|account|support|salt"), keep the salt here for the reveal.
      const who = state.actor;
      if (!who) throw new Error("Connect your account first: the sealed vote includes it.");
      const had = getBallot(offer, round, who);
      if (had && had.support !== support) throw new Error(`This browser already sealed ${had.support ? "YES" : "NO"} for this round.`);
      const salt = had?.salt || randomHex(16);
      const commitment = await sha256Hex(`${offer}|${round}|${who}|${support}|${salt}`);
      const saved = putBallot(offer, round, who, { support, salt });
      return ["vote_sealed", { offer, commitment }, 0n, coin, {
        // Only reached when the browser refuses localStorage: the salt must not be lost.
        ok: () => { if (!saved) { state.dialog = { type: "salt", offer, support, salt }; bump(); } },
        // A contract panic or a wallet cancel means nothing was recorded, so the ballot can go.
        // Any other error may hide a vote that landed: keep the salt for the reveal.
        fail: (msg) => { if (!had && /panicked|already voted|no tokens locked|voting is closed|reject|cancel|denied/i.test(msg)) dropBallot(offer, round, who); },
      }];
    },
    reveal: () => {
      const b = getBallot(offer, round, state.actor);
      if (!b) throw new Error("No sealed vote from this browser for this round.");
      return ["reveal_vote", { offer, support: b.support, salt: b.salt }, 0n];
    },
    veto: () => ["veto", { offer_id: Number(id) }, 0n],
    finalize: () => ["finalize", { offer }, 0n],
    propose: () => ["propose_offer", { target: d.target, rate_ppm: d.rate, pitch: d.pitch }, 0n],
    // The rate on screen: if the counter changes before this lands, the contract refuses.
    accept_counter: () => ["accept_counter", { offer_id: Number(id), rate_ppm: d.rate ?? null }, 0n],
    convert: () => ["convert", {}, 1n],
    back_tender: () => ["back_tender", { tender_id: Number(id) }, 0n],
    veto_tender: () => ["veto_tender", { tender_id: Number(id) }, 0n],
    settle_tender: () => ["settle_tender", { tender_id: Number(id) }, 0n],
    claim_tender: () => ["claim_tender", { tender_id: Number(id) }, 0n],
  };
  if (!plans[what] || state.acting) return false;
  const [doing, doneText] = SAY[what] || [what, "Done."];
  let plan;
  try { plan = await plans[what](); } catch (e) { toast.error(String(e.message || e)); return false; }
  const [method, args, deposit, contract = coin, hooks = {}] = plan;
  // The page signs by itself for the demo's holders and for a guest; anything else goes to a wallet or the CLI.
  const key = cfg.dev_key || (!state.wallet && guest?.account === state.actor ? guest.key : null);
  if (!key) {
    if (hasWallet() && !state.wallet) {
      if (state.guestOffer) { state.dialog = { type: "signin" }; bump(); return false; }
      toast("Connect a wallet first, so the page knows which account is yours."); connectWallet(); return false;
    }
    if (!hasWallet()) {
      const net = NETWORK === "local" ? "testnet" : NETWORK;
      state.dialog = {
        type: "cli", title: doing, sealed: method === "vote_sealed",
        command: `near contract call-function as-transaction ${contract} ${method} json-args '${JSON.stringify(args)}' prepaid-gas '300 Tgas' attached-deposit '${deposit} yoctoNEAR' sign-as ${state.actor || `<you>.${net}`} network-config ${net} sign-with-legacy-keychain send`,
      };
      bump();
      return false;
    }
  }
  state.acting = true; bump();
  const tid = toast.loading(key ? `${doing}…` : `${doing}: approve it in your wallet…`);
  let gasless = false;
  const sent = (async () => {
    if (!key) return walletCall(contract, method, args, deposit);
    nearApi ??= await import(/* @vite-ignore */ NEAR_API);
    const account = new nearApi.Account(state.actor, sendProvider(), key);
    if (cfg.dev_key && cfg.relayer && state.gasless && GASLESS.includes(method)) {
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
      gasless = true;
    } else {
      return account.callFunctionRaw({ contractId: contract, methodName: method, args, deposit, gas: GAS });
    }
  })();
  // A bid the target refuses still lands: the buyer's callback records the refusal. The
  // target's reason is only in the receipts, so look there and count it as a failure.
  const outcome = sent.then((out) => {
    const why = what === "propose" && refusalIn(out);
    return why ? new Error(`$${sym(d.target)} refused the bid: ${humanize(why)}. No vote opens. Your locked $${sym(coin)} stay held for the vote period anyway: see Your position.`, { cause: "refused" }) : null;
  }, (e) => e || new Error("failed"));
  // A node can sit on a call long after the chain has settled it. Past `patience` the page
  // lets go: the buttons come back and the outcome is told when it arrives. Think lets go
  // soonest: a refused Think fails within seconds, an accepted one waits for the brain.
  // A wallet keeps its own pace (the holder may still be reading the request), so no limit there.
  const patience = !key ? 0 : what === "think" ? 8_000 : 40_000;
  let timer;
  const late = patience > 0 && await Promise.race([
    outcome.then(() => false),
    new Promise((r) => { timer = setTimeout(() => r(true), patience); }),
  ]);
  clearTimeout(timer);
  if (late) {
    if (what === "think") toast.success(doneText, { id: tid });
    else toast.info(`${doing}: the network is slow to confirm. Carry on; the result will show here.`, { id: tid, duration: 8000 });
    state.acting = false; bump();
    refresh();
  }
  const e = await outcome;
  if (!e) {
    hooks.ok?.();
    if (!late || what !== "think") toast.success(`${doneText}${gasless ? " The relayer paid the fee." : ""}`, late ? {} : { id: tid });
  } else {
    const msg = String(e.message || e);
    hooks.fail?.(msg);
    const text = e.cause === "refused" ? msg
      : /reject|cancel|denied/i.test(msg) && !key ? "Cancelled in the wallet. Nothing was sent."
      : noAnswer(e) ? `${late ? `${doing}: the` : "The"} network didn't answer, so it's unclear whether that went through. Wait a moment and check before trying again.`
      : late ? `${doing} failed: ${plainError(msg)}` : `That didn't go through: ${plainError(msg)}`;
    // A late Think the nodes never confirmed is told by the Brains page itself: a decision shows up there or it doesn't.
    if (!(late && what === "think" && noAnswer(e))) toast.error(text, { ...(late ? {} : { id: tid }), duration: e.cause === "refused" ? 15000 : undefined });
  }
  if (!late) { state.acting = false; bump(); }
  refresh();
  return !e;
}

/** Demo only: sign one call as any of the sandbox's demo accounts. */
export async function devCall(as, contract, method, args = {}, deposit = 0n) {
  if (!cfg.dev_key) throw new Error("Only the local demo can sign for its holders.");
  nearApi ??= await import(/* @vite-ignore */ NEAR_API);
  return new nearApi.Account(as, cfg.rpc, cfg.dev_key).callFunction({ contractId: contract, methodName: method, args, deposit, gas: GAS });
}

// ---------- first steps ----------
/** The five first steps, each ticked off from what the chain says about this account. */
export function guideSteps() {
  const who = state.me.acct, me = state.me;
  const locked = Object.values(me.locks).some((l) => l.length);
  const holds = locked || Object.values(me.bal).some((b) => b > 0n);
  const events = Object.values(state.history).flat();
  const did = (names) => !!who && events.some((e) => names.includes(e.event) && e.text.startsWith(`${who} `));
  const fee = state.params ? fmtNear(state.params.brain_fee) : "";
  const wallet = hasWallet();
  const steps = [
    cfg.dev_key
      ? { done: !!who, title: "Pick a demo holder", text: `You are playing as ${short(who) || "nobody"}, with play money. Switch any time at the top.`, go: "who", btn: "Switch holder" }
      : wallet && state.guestOffer
        ? { done: !!who, title: "Get a test account", text: `Try as a guest and the page makes you a testnet account with ${state.guestOffer.near} test NEAR. Or connect a testnet wallet. No real money either way.`, go: "guest", btn: "Try as guest" }
        : { done: !!who, title: wallet ? "Connect a wallet" : "Enter your account", text: wallet ? "A free NEAR testnet wallet. No real money is involved." : "Type your account at the top to see your balances.", go: "who", btn: wallet ? "Connect" : "Enter account" },
    { done: holds, title: "Buy your first coin", text: "Pick any coin, type how much NEAR to spend and press Buy. You can sell back any time.", go: "buy", btn: "Buy a coin" },
    { done: locked, title: "Lock some to get a vote", text: "Locking keeps the tokens yours and makes them count as votes. Do it before a bid shows up.", go: "lock", btn: "Lock tokens" },
    { done: did(["think"]), title: "Wake a brain", text: `Press Think and the coin's AI looks at its rivals. It may make a bid. Costs ${fee}; the answer takes up to 2 minutes.`, go: "think", btn: "Show me" },
    { done: did(["vote", "vote_sealed", "veto", "tender_backed", "tender_veto"]), title: "Have your say on a deal", text: "Open bids appear under Deals. Vote yes or no with what you locked.", go: "deals", btn: "See the deals" },
  ];
  // Once done, a step stays done even when the event scrolls out of the coin's history.
  const key = `autocto:guide:${cfg.launchpad}:${who}`;
  const saved = who ? Number(store.get(key) || 0) : 0;
  let mask = 0;
  steps.forEach((x, k) => { if (x.done || (saved >> k) & 1) { x.done = true; mask |= 1 << k; } });
  if (who && mask !== saved) store.set(key, String(mask));
  return steps;
}
