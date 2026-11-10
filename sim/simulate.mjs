// AutoCTO community simulation: 60 days, five scenarios, one parameter sweep.
//
//   node sim/simulate.mjs            -> prints the report, writes web/data/sim.json and sim/REPORT.md
//
// The model mirrors the contract rules (contracts/coin): a constant-product
// curve with a virtual NEAR reserve, locks with a snapshot rule, quorum and
// approval on the target, a veto on the buyer, premium/discount/dilution caps,
// newborn protection, cooldowns, and conversion after a merge. Holder
// behaviour is a seeded random model, so every run gives the same numbers.

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DAYS = 60;

// Base parameters; the sweep below picks quorum/approval/veto.
export const PARAMS = {
  supply: 1e9, virtualNear: 30, feeBps: 100,
  maxPremiumBps: 3000, maxDiscountBps: 3000, maxDilutionBps: 10000,
  voteDays: 2, quorumBps: 1000, approvalBps: 6700, vetoBps: 1000,
  newbornDays: 3, rebidCooldownDays: 5, convertPerDay: 0.35,
};

// ---------- seeded randomness ----------
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- the coin ----------
class Coin {
  constructor(sym, P, bornDay = 0) {
    Object.assign(this, { sym, P, bornDay, ammNear: P.virtualNear, ammTokens: P.supply, total: P.supply, treasury: 1, status: "Active", into: null, rate: 0 });
    this.holders = new Map(); // name -> { free, lots: [{ amount, day }] }
    this.absorbed = new Map(); // target sym -> { rate, max, converted }
  }
  price() { return this.ammNear / this.ammTokens; }
  circ() { return this.total - this.ammTokens; }
  mcap() { return this.price() * this.circ(); }
  h(name) { if (!this.holders.has(name)) this.holders.set(name, { free: 0, lots: [] }); return this.holders.get(name); }
  buy(name, near) {
    if (this.status !== "Active") return 0;
    const fee = near * this.P.feeBps / 1e4, net = near - fee;
    const out = this.ammTokens * net / (this.ammNear + net);
    this.ammNear += net; this.ammTokens -= out; this.treasury += fee;
    this.h(name).free += out;
    return out;
  }
  sell(name, amount) {
    const h = this.h(name);
    amount = Math.min(amount, h.free);
    if (this.status !== "Active" || amount <= 0) return 0;
    const gross = this.ammNear * amount / (this.ammTokens + amount);
    if (this.ammNear - gross < this.P.virtualNear) return 0;
    this.ammNear -= gross; this.ammTokens += amount; h.free -= amount;
    this.treasury += gross * this.P.feeBps / 1e4;
    return gross;
  }
  lock(name, amount, day) {
    const h = this.h(name);
    amount = Math.min(amount, h.free);
    if (amount <= 0) return;
    h.free -= amount; h.lots.push({ amount, day });
  }
  weightAt(name, day) {
    const h = this.holders.get(name);
    return h ? h.lots.filter((l) => l.day < day).reduce((s, l) => s + l.amount, 0) : 0;
  }
  balance(name) { const h = this.holders.get(name); return h ? h.free + h.lots.reduce((s, l) => s + l.amount, 0) : 0; }
}

// ---------- the takeover rules ----------
function fairRate(buyer, target) { return target.price() / buyer.price(); }

function makeOffer(world, buyer, target, premiumBps, day, opts = {}) {
  const P = world.P;
  const why = (r) => { world.log.push(`day ${day}: ${buyer.sym} → ${target.sym} refused: ${r}`); return null; };
  if (buyer.status !== "Active" || target.status !== "Active") return why("not active");
  if (day < target.bornDay + P.newbornDays) return why("newborn protection");
  if ((world.cooldown.get(`${buyer.sym}>${target.sym}`) ?? -1e9) > day) return why("cooldown");
  if (world.offers.some((o) => o.open && [o.buyer, o.target].includes(buyer) && [o.buyer, o.target].includes(target))) return why("one open offer per pair");
  if (premiumBps > P.maxPremiumBps || premiumBps < -P.maxDiscountBps) return why("premium outside caps");
  const fair = fairRate(buyer, target);
  const rate = fair * (1 + premiumBps / 1e4);
  if (target.circ() * rate > buyer.circ() * P.maxDilutionBps / 1e4) return why("dilution cap");
  const o = { buyer, target, rate, premiumBps, created: day, ends: day + P.voteDays, yes: 0, no: 0, veto: 0, voters: new Set(), open: true, targetCirc: target.circ(), buyerCirc: buyer.circ(), ...opts };
  world.offers.push(o);
  world.log.push(`day ${day}: ${buyer.sym} bids for ${target.sym} at ${premiumBps >= 0 ? "+" : ""}${premiumBps / 100}%`);
  return o;
}

function vote(o, coin, name, support) {
  const w = coin.weightAt(name, o.created);
  if (w <= 0 || o.voters.has(name)) return false;
  o.voters.add(name);
  if (support) o.yes += w; else o.no += w;
  return true;
}

function veto(o, name) {
  const w = o.buyer.weightAt(name, o.created);
  if (w <= 0 || o.voters.has("veto:" + name)) return false;
  o.voters.add("veto:" + name);
  o.veto += w;
  return true;
}

function finalize(world, o, day) {
  const P = world.P;
  o.open = false;
  const fail = (r) => { o.result = r; world.cooldown.set(`${o.buyer.sym}>${o.target.sym}`, day + P.rebidCooldownDays); world.log.push(`day ${day}: ${o.buyer.sym} → ${o.target.sym} failed: ${r}`); return false; };
  if (o.target.status !== "Active") return fail("target already merged");
  const turnout = o.yes + o.no;
  if (turnout === 0 || turnout < o.targetCirc * P.quorumBps / 1e4) return fail("quorum not reached");
  if (o.yes < turnout * P.approvalBps / 1e4) return fail("rejected by holders");
  if (o.buyer.status !== "Active") return fail("buyer no longer active");
  if (o.veto > 0 && o.veto >= o.buyerCirc * P.vetoBps / 1e4) return fail("vetoed by buyer holders");
  const circ = o.target.circ();
  if (circ * o.rate > o.buyer.circ() * P.maxDilutionBps / 1e4) return fail("dilution cap at execution");
  // Merge: curve NEAR deepens the buyer's curve, treasury moves, target goes convert-only.
  o.buyer.ammNear += o.target.ammNear - P.virtualNear;
  o.buyer.treasury += o.target.treasury;
  o.target.ammNear = P.virtualNear; o.target.treasury = 0;
  o.target.status = "Merged"; o.target.into = o.buyer; o.target.rate = o.rate;
  o.buyer.absorbed.set(o.target.sym, { rate: o.rate, max: circ, converted: 0 });
  o.result = "merged";
  world.log.push(`day ${day}: ${o.target.sym} MERGED into ${o.buyer.sym} at ${o.rate.toFixed(4)}`);
  return true;
}

function convertStep(world, r) {
  for (const t of world.coins.filter((c) => c.status === "Merged")) {
    for (const [name, h] of t.holders) {
      const bal = t.balance(name);
      if (bal <= 0 || r() > world.P.convertPerDay) continue;
      const rec = t.into.absorbed.get(t.sym);
      if (rec.converted + bal > rec.max + 1e-6) continue;
      h.free = 0; h.lots = []; t.total -= bal; // burn on the target
      const minted = bal * t.rate;
      t.into.h(name).free += minted; t.into.total += minted; // mint on the buyer
      rec.converted += bal;
    }
  }
}

// ---------- holder behaviour ----------
function population(world, coin, n, nearEach, r, prefix, lockShare = 0.5) {
  for (let i = 0; i < n; i++) {
    const name = `${prefix}${i}`;
    const stake = nearEach * (0.3 + 1.4 * r());
    coin.buy(name, stake);
    if (r() < lockShare) coin.lock(name, coin.h(name).free * (0.4 + 0.6 * r()), 0);
    world.people.push({ name, coin, stake, engaged: 0.25 + 0.6 * r(), greed: 0.03 + 0.12 * r() });
  }
}

/// Locked holders vote: yes when the premium beats their personal threshold.
function holdersVote(world, o, r, tilt = 0) {
  for (const p of world.people.filter((p) => p.coin === o.target)) {
    if (r() > p.engaged) continue;
    const want = o.premiumBps / 1e4 + tilt + (r() - 0.5) * 0.06;
    vote(o, o.target, p.name, want > p.greed);
  }
}

/// Buyer holders veto deals that dilute them for a big premium.
function buyersVeto(world, o, r, tolerance = 0.5) {
  const dilution = o.targetCirc * o.rate / o.buyerCirc;
  for (const p of world.people.filter((p) => p.coin === o.buyer)) {
    if (r() > p.engaged) continue;
    const pain = dilution * Math.max(0, o.premiumBps / 1e4) * 4 + (dilution > tolerance ? dilution - tolerance : 0);
    if (pain > 0.25 + r() * 0.3) veto(o, p.name);
  }
}

function dailyNoise(world, r) {
  for (const p of world.people) {
    if (p.coin.status !== "Active") continue;
    const x = r();
    if (x < 0.06) p.coin.buy(p.name, p.stake * (0.05 + 0.25 * r()));
    else if (x < 0.1) p.coin.sell(p.name, p.coin.h(p.name).free * 0.3);
  }
}

function newWorld(P = PARAMS) {
  return { P, coins: [], people: [], offers: [], cooldown: new Map(), log: [] };
}

function track(world) {
  const s = {};
  for (const c of world.coins) s[c.sym] = [];
  return s;
}
function record(world, series) {
  for (const c of world.coins) series[c.sym].push(+(c.circ() / 1e6).toFixed(2));
}

// ---------- scenarios ----------
function friendly(P, seed = 1) {
  const r = rng(seed), w = newWorld(P);
  const pepe = new Coin("PEPE", w.P), doge = new Coin("DOGE", w.P);
  w.coins.push(pepe, doge);
  population(w, pepe, 120, 0.4, r, "p"); population(w, doge, 60, 0.15, r, "d");
  const s = track(w);
  let o;
  for (let day = 0; day <= DAYS; day++) {
    dailyNoise(w, r);
    if (day === 6) o = makeOffer(w, pepe, doge, 1000, day); // brain bids +10%
    if (day === 7 && o) { o.premiumBps = 2000; o.rate = fairRate(pepe, doge) * 1.2; o.yes = o.no = 0; o.voters.clear(); o.ends = day + w.P.voteDays; w.log.push(`day 7: DOGE counters +20%, PEPE accepts, vote restarts`); }
    if (o?.open && day === o.ends - 1) { holdersVote(w, o, r, 0.02); buyersVeto(w, o, r); }
    if (o?.open && day >= o.ends) finalize(w, o, day);
    convertStep(w, r);
    record(w, s);
  }
  return { title: "Friendly merger: bid +10%, counter +20%, accepted", supply: s, outcome: outcome(w) };
}

function hostile(P, seed = 2) {
  const r = rng(seed), w = newWorld(P);
  const pepe = new Coin("PEPE", w.P), doge = new Coin("DOGE", w.P);
  w.coins.push(pepe, doge);
  population(w, pepe, 120, 0.4, r, "p"); population(w, doge, 60, 0.15, r, "d");
  const s = track(w);
  const bids = [[5, -2000], [12, -500], [20, 300]];
  const live = [];
  for (let day = 0; day <= DAYS; day++) {
    dailyNoise(w, r);
    for (const [d, prem] of bids) if (d === day) { const o = makeOffer(w, pepe, doge, prem, day); if (o) live.push(o); }
    for (const o of live) {
      if (o.open && day === o.ends - 1) { holdersVote(w, o, r, -0.04); buyersVeto(w, o, r); }
      if (o.open && day >= o.ends) finalize(w, o, day);
    }
    record(w, s);
  }
  return { title: "Hostile lowballs: -20%, then -5% (cooldown), then +3%", supply: s, outcome: outcome(w) };
}

function attack(P, seed = 3) {
  const r = rng(seed), w = newWorld(P);
  const pepe = new Coin("PEPE", w.P), doge = new Coin("DOGE", w.P);
  w.coins.push(pepe, doge);
  population(w, pepe, 140, 0.4, r, "p"); population(w, doge, 90, 0.3, r, "d");
  // Insiders quietly buy and lock DOGE on day 1, before any bid exists.
  doge.buy("insider", 12); doge.lock("insider", doge.h("insider").free, 1);
  const s = track(w);
  let o;
  for (let day = 0; day <= DAYS; day++) {
    dailyNoise(w, r);
    if (day === 6) {
      // ...then push PEPE to overpay for DOGE at the maximum premium,
      // and a late whale buys DOGE after the bid to add yes votes.
      o = makeOffer(w, pepe, doge, 2900, day);
      doge.buy("late-whale", 20); doge.lock("late-whale", doge.h("late-whale").free, day);
    }
    if (o?.open && day === o.ends - 1) {
      vote(o, doge, "insider", true);
      const counted = vote(o, doge, "late-whale", true);
      w.log.push(`day ${day}: late whale's lock ${counted ? "COUNTED" : "refused by the snapshot rule"}`);
      holdersVote(w, o, r, 0.05);
      buyersVeto(w, o, r);
    }
    if (o?.open && day >= o.ends) finalize(w, o, day);
    convertStep(w, r);
    record(w, s);
  }
  return { title: "Insiders push an overpriced bid: snapshot drops the late whale, PEPE holders veto", supply: s, outcome: outcome(w) };
}

function chain(P, seed = 4) {
  const r = rng(seed), w = newWorld(P);
  const a = new Coin("PEPE", w.P), b = new Coin("DOGE", w.P), c = new Coin("WOJAK", w.P);
  w.coins.push(a, b, c);
  population(w, a, 150, 0.5, r, "a"); population(w, c, 80, 0.25, r, "c"); population(w, b, 50, 0.12, r, "b", 0.7);
  const s = track(w);
  const live = [];
  for (let day = 0; day <= DAYS; day++) {
    dailyNoise(w, r);
    if (day === 8) { const o = makeOffer(w, c, b, 1800, day); if (o) live.push(o); }
    // If the first bid failed, WOJAK's brain rebids higher once the cooldown ends.
    if (day === 16 && b.status === "Active") { const o = makeOffer(w, c, b, 2600, day); if (o) live.push(o); }
    if (day === 30) { const o = makeOffer(w, a, c, 1600, day); if (o) live.push(o); }
    for (const o of live) {
      if (o.open && day === o.ends - 1) { holdersVote(w, o, r, 0.03); buyersVeto(w, o, r); }
      if (o.open && day >= o.ends) finalize(w, o, day);
    }
    // Holders of a merged coin can convert again if their new coin merges too.
    convertStep(w, r);
    record(w, s);
  }
  return { title: "Chain of three: WOJAK bids for an engaged DOGE (70% of holders lock), then PEPE bids for WOJAK", supply: s, outcome: outcome(w) };
}

function biddingWar(P, seed = 5) {
  const r = rng(seed), w = newWorld(P);
  const a = new Coin("PEPE", w.P), c = new Coin("WOJAK", w.P), baby = new Coin("BABY", w.P, 10);
  w.coins.push(a, c, baby);
  population(w, a, 120, 0.4, r, "a"); population(w, c, 100, 0.35, r, "c");
  const s = track(w);
  const live = [];
  for (let day = 0; day <= DAYS; day++) {
    if (day === 10) population(w, baby, 70, 0.12, r, "z");
    dailyNoise(w, r);
    if (day === 11) makeOffer(w, a, baby, 2000, day); // refused: newborn protection
    if (day === 13) { for (const [buyer, prem] of [[a, 1200], [c, 2200]]) { const o = makeOffer(w, buyer, baby, prem, day); if (o) live.push(o); } }
    for (const o of live) {
      if (o.open && day === o.ends - 1) { holdersVote(w, o, r, 0); buyersVeto(w, o, r); }
    }
    // Both votes end the same day; the richer bid is finalized first by its fans.
    for (const o of [...live].sort((x, y) => y.premiumBps - x.premiumBps)) if (o.open && day >= o.ends) finalize(w, o, day);
    convertStep(w, r);
    record(w, s);
  }
  return { title: "Bidding war over a newborn: protection, then +12% vs +22%", supply: s, outcome: outcome(w) };
}

function outcome(w) {
  const merges = w.log.filter((l) => l.includes("MERGED")).map((l) => l.replace(/^day (\d+): /, "day $1: "));
  const fails = w.log.filter((l) => l.includes("failed") || l.includes("refused") || l.includes("snapshot"));
  return [...merges, ...fails].join(" · ") || "no deal";
}

// ---------- parameter sweep ----------
// Random pairs, random bids. A "bad deal" for the target is a discount; for the
// buyer it is heavy dilution at a high premium. We want good deals to pass and
// bad ones to fail, including when a whale tries to vote with a late lock.
function sweep(runs = 400) {
  const grid = [];
  for (const quorumBps of [1000, 2000, 3000])
    for (const approvalBps of [5500, 6000, 6700])
      for (const vetoBps of [1000, 1500, 2500]) grid.push({ quorumBps, approvalBps, vetoBps });
  const rows = grid.map((g) => {
    const P = { ...PARAMS, ...g };
    let good = 0, goodPass = 0, bad = 0, badPass = 0, attackPass = 0, attacks = 0;
    for (let i = 0; i < runs; i++) {
      const r = rng(1000 + i), w = newWorld(P);
      const buyer = new Coin("B", P), target = new Coin("T", P);
      w.coins.push(buyer, target);
      population(w, buyer, 60 + Math.floor(r() * 100), 0.3 + r() * 0.3, r, "b", 0.3 + r() * 0.4);
      population(w, target, 30 + Math.floor(r() * 60), 0.1 + r() * 0.15, r, "t", 0.3 + r() * 0.4);
      const premium = Math.round((-0.25 + r() * 0.55) * 1e4);
      const o = makeOffer(w, buyer, target, premium, 5);
      if (!o) continue;
      const dilution = o.targetCirc * o.rate / o.buyerCirc;
      const isBad = premium < 0 || (dilution > 0.6 && premium > 2000);
      const isAttack = r() < 0.3;
      if (isAttack) { attacks++; target.buy("whale", 15); target.lock("whale", target.h("whale").free, 5); vote(o, target, "whale", true); }
      holdersVote(w, o, r, isAttack ? 0.0 : 0);
      buyersVeto(w, o, r);
      const passed = finalize(w, o, o.ends);
      if (isBad) { bad++; if (passed) badPass++; } else if (premium >= 1000) { good++; if (passed) goodPass++; }
      if (isAttack && passed && isBad) attackPass++;
    }
    const goodRate = good ? goodPass / good : 0, badRate = bad ? badPass / bad : 0;
    return { ...g, goodPassRate: +goodRate.toFixed(3), badPassRate: +badRate.toFixed(3), attackBadPasses: attackPass, attacks, score: +(goodRate - 3 * badRate).toFixed(3) };
  });
  rows.sort((a, b) => b.score - a.score);
  return rows;
}

// ---------- main ----------
// 1. Sweep. 2. Pick the most conservative combination (highest approval, then
// lowest veto threshold) scoring within 0.05 of the best. 3. Run the scenarios
// with it.
const sweepRows = sweep();
const top = sweepRows[0].score;
const best = sweepRows
  .filter((r) => r.score >= top - 0.05)
  .sort((a, b) => b.approvalBps - a.approvalBps || a.vetoBps - b.vetoBps || b.score - a.score)[0];
const CHOSEN = { ...PARAMS, quorumBps: best.quorumBps, approvalBps: best.approvalBps, vetoBps: best.vetoBps };
const scenarios = [friendly(CHOSEN), hostile(CHOSEN), attack(CHOSEN), chain(CHOSEN), biddingWar(CHOSEN)];

const lines = [];
lines.push(`# AutoCTO simulation report`, ``, `${DAYS} days per scenario, seeded (re-run with \`node sim/simulate.mjs\`).`, ``);
lines.push(`## Scenarios with the chosen parameters (circulating supply in millions, day 0 → day 60)`, ``);
for (const s of scenarios) {
  lines.push(`### ${s.title}`);
  for (const [k, v] of Object.entries(s.supply)) lines.push(`- ${k}: ${v[0]} → ${v[v.length - 1]}`);
  lines.push(`- outcome: ${s.outcome}`, ``);
}
lines.push(`## Parameter sweep (${sweepRows.length} combinations × 400 random bids)`, ``);
lines.push(`score = good-deal pass rate − 3 × bad-deal pass rate. Bad = a discount for the target, or >60% dilution at >20% premium for the buyer. 30% of bids face a whale who buys and locks after the bid.`, ``);
lines.push(`| quorum | approval | veto | good deals pass | bad deals pass | score |`, `|---|---|---|---|---|---|`);
for (const r of sweepRows.slice(0, 10)) lines.push(`| ${r.quorumBps / 100}% | ${r.approvalBps / 100}% | ${r.vetoBps / 100}% | ${(r.goodPassRate * 100).toFixed(1)}% | ${(r.badPassRate * 100).toFixed(1)}% | ${r.score} |`);
lines.push(``, `Chosen (most conservative within 0.05 of the best score): quorum ${best.quorumBps / 100}%, approval ${best.approvalBps / 100}%, veto ${best.vetoBps / 100}%, score ${best.score}. Late whale locks never counted (snapshot rule); bad deals that passed with a whale present: ${best.attackBadPasses} of ${best.attacks} attacked bids.`);
const report = lines.join("\n");
console.log(report);

mkdirSync(join(ROOT, "web/data"), { recursive: true });
writeFileSync(join(ROOT, "web/data/sim.json"), JSON.stringify({ days: DAYS, params: CHOSEN, chosen: best, scenarios, sweep: sweepRows }, null, 1));
writeFileSync(join(ROOT, "sim/REPORT.md"), report + "\n");
