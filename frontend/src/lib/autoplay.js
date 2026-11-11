// The local demo can play a whole takeover by itself: its holders lock, a brain bids,
// they vote, the vote is counted. Every step is a real call on the sandbox chain.
import { NS, UNIT, YOCTO, bump, cfg, devCall, fmtRate, now, refresh, state, statusName, sym, view } from "./chain";

// Coins the demo launches when only one is left to play against.
const RIVALS = [
  ["Bonk", "A loud dog with a fat treasury and no plan."],
  ["Chad", "Confident, overextended, never sells."],
  ["Moon", "Only ever looks up. Ignores every warning."],
  ["Frogs", "A swarm of small frogs that sticks together."],
  ["Cat", "Aloof. Accepts offers only on its own terms."],
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mcap = (i) => (BigInt(i.price_yocto) * BigInt(i.circulating)) / UNIT;
const info = (a) => view(a, "coin_info");
// The contract's own words, without the wrapping.
const reason = (e) => (String(e?.message || e).match(/Smart contract panicked: ([^"\\]+)/)?.[1] || String(e?.message || e)).slice(0, 200);

export function closeAuto() { if (!state.auto?.running) { state.auto = null; bump(); } }

export async function playTakeover() {
  if (!cfg.dev_key || state.auto?.running) return;
  const auto = (state.auto = { running: true, steps: [], error: null, until: null });
  const step = (text) => {
    const last = auto.steps.at(-1);
    if (last) last.done = true;
    auto.steps.push({ text, done: false });
    bump();
  };
  const who = cfg.accounts || [];
  const actor = state.actor || who[0];
  try {
    const live = [];
    let newborn = 0n;
    for (const { account_id: a } of state.coins) {
      const i = await info(a);
      if (statusName(i.status) === "Active") live.push([a, i]);
    }
    if (!live.length) throw new Error("No coin is trading. Launch one first.");
    if (live.length < 2) {
      // Only one coin is left standing: launch it a rival, and give the rival some holders.
      const taken = new Set(state.coins.map((c) => c.account_id));
      const [name, persona] = RIVALS.find(([n]) => !taken.has(`${n.toLowerCase()}.${cfg.launchpad}`)) || [`Rival${state.coins.length}`, RIVALS[0][1]];
      const label = name.toLowerCase(), a = `${label}.${cfg.launchpad}`;
      step(`Only one coin is left, so a new rival launches: $${name.toUpperCase()}.`);
      const min = BigInt(await view(cfg.launchpad, "min_launch_deposit"));
      await devCall(actor, cfg.launchpad, "launch", { label, name, symbol: name.toUpperCase(), icon: null, persona }, min + YOCTO);
      for (const acct of who.slice(0, 3)) await devCall(acct, a, "buy", { min_out: "0" }, 4n * YOCTO).catch(() => {});
      await refresh();
      const i = await info(a);
      live.push([a, i]);
      newborn = BigInt(i.protected_until || 0);
    }
    live.sort((x, y) => (mcap(y[1]) > mcap(x[1]) ? 1 : -1));
    const bidder = live[0][0], B = sym(bidder), rivals = live.slice(1).map(([a]) => a);
    step(`$${B} is the biggest coin, so it plays the hunter.`);

    // Only tokens locked before a bid count for it, so the voters go first.
    step("Demo holders lock tokens in the smaller coins. That gives them a vote.");
    for (const r of rivals) {
      for (const acct of who) {
        const [bal, locks] = await Promise.all([view(r, "ft_balance_of", { account_id: acct }), view(r, "locks_of", { account_id: acct })]);
        if (BigInt(bal) > 0n && !locks.length) await devCall(acct, r, "lock", { amount: (BigInt(bal) / 2n).toString() }).catch(() => {});
      }
      const i = await info(r);
      // Too few voters to reach quorum: one holder buys in and locks it all.
      if (BigInt(i.total_locked) * 100n < BigInt(i.circulating) * 20n) {
        await devCall(who[0], r, "buy", { min_out: "0" }, 5n * YOCTO);
        const bal = BigInt(await view(r, "ft_balance_of", { account_id: who[0] }));
        if (bal > 0n) await devCall(who[0], r, "lock", { amount: bal.toString() });
      }
    }

    // A brain only hunts coins clearly smaller than its own.
    const smaller = async () => {
      const mine = mcap(await info(bidder));
      for (const r of rivals) if (mcap(await info(r)) * 100n < mine * 75n) return true;
      return false;
    };
    if (!(await smaller())) {
      step(`A holder buys $${B}, so it is clearly bigger than its rivals.`);
      for (let k = 0; k < 4 && !(await smaller()); k++) await devCall(who[k % who.length], bidder, "buy", { min_out: "0" }, 10n * YOCTO).catch(() => {});
    }
    refresh();

    if (newborn > now()) {
      step("A new coin cannot be bid for right away. Waiting out its newborn protection.");
      auto.until = newborn.toString(); bump();
      while (now() <= newborn + 2n * NS) await sleep(1000);
      auto.until = null;
    }
    step(`Waking $${B}'s brain. It sizes up its rivals.`);
    const id = (await info(bidder)).decisions;
    await devCall(actor, bidder, "think", {}, 10n ** 23n);
    let d = null;
    for (let k = 0; k < 45; k++) {
      await sleep(1000);
      d = (await view(bidder, "list_decisions", { limit: 12 })).find((x) => x.id === id);
      if (d && statusName(d.status) !== "Pending") break;
    }
    refresh();
    const o = (await view(bidder, "list_offers")).filter((x) => x.buyer === bidder && statusName(x.status) === "Open" && d && BigInt(x.created_at) >= BigInt(d.requested_at))[0];
    if (!o) {
      let thought = "";
      try { thought = JSON.parse(d.output).thought; } catch (_) {}
      throw new Error(thought ? `The brain chose not to bid: “${thought}”` : "The brain did not answer. Is the demo still running?");
    }
    const target = o.target, T = sym(target), key = `${o.buyer}#${o.id}`;
    step(`It bids for $${T}: ${fmtRate(o.rate_ppm)} $${B} for each $${T}. Now $${T}'s holders vote.`);
    location.hash = "#deals";
    if (state.params.reveal_period_sec > 0) throw new Error("Votes are sealed on this chain, so the rest is by hand: vote, reveal, then finalize.");

    let voted = 0;
    for (const acct of who) {
      const locks = await view(target, "locks_of", { account_id: acct });
      if (!locks.some((l) => BigInt(l.since) < BigInt(o.created_at))) continue;
      await devCall(acct, target, "vote", { offer: key, support: true }).then(() => voted++, () => {});
      refresh();
    }
    step(`${voted} ${voted === 1 ? "holder" : "holders"} voted yes. Waiting for the vote to close.`);
    auto.until = o.vote_ends; bump();
    while (now() <= BigInt(o.vote_ends) + 2n * NS) await sleep(1000);
    auto.until = null;

    step("The vote is over. Anyone can ask the contract to count it.");
    await devCall(actor, target, "finalize", { offer: key });
    let merged = false, failed = null;
    for (let k = 0; k < 20 && !merged && !failed; k++) {
      await sleep(1000);
      merged = statusName((await info(target)).status) === "Merged";
      const mine = (await view(target, "list_offers")).find((x) => x.buyer === bidder && x.id === o.id);
      if (mine && statusName(mine.status) === "Failed") failed = mine.status.Failed.reason;
    }
    if (failed) throw new Error(`The deal did not go through: ${failed}.`);
    if (!merged) throw new Error("The merge has not finished yet. Check the deal in a moment.");
    step(`Done: $${B} ate $${T}. Its NEAR and treasury moved over, and $${T} holders can convert.`);
    auto.steps.at(-1).done = true;
  } catch (e) {
    auto.error = reason(e);
  } finally {
    auto.running = false; auto.until = null;
    bump(); refresh();
  }
}
