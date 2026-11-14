// The arena's script, read from the chain: the latest takeover a coin's brain started, told through the
// two coins' own history logs. No React and no browser-only APIs, so scripts/record-arena.mjs can run
// it to record web/data/arena-<network>.json, the copy the landing falls back to when the chain doesn't answer.

const UNIT = 10n ** 18n; // one whole token
const YOCTO = 1e24;
const near = (yocto) => Number(BigInt(yocto) / 10n ** 18n) / 1e6;
// Market cap in NEAR: price per whole token times tokens in circulation.
const capOf = (i) => near((BigInt(i.price_yocto) * BigInt(i.circulating)) / UNIT);
const tokens = (n) => {
  const x = Number(n);
  return x >= 1e9 ? `${+(x / 1e9).toFixed(2)}B` : x >= 1e6 ? `${+(x / 1e6).toFixed(2)}M` : x >= 1e3 ? `${+(x / 1e3).toFixed(1)}K` : String(x);
};
const fmtNear = (n) => `${+n.toFixed(n < 1 ? 3 : 2)} NEAR`;

// How long each beat stays on screen: long enough to read what was said. The last beat holds a little
// longer before the replay starts again.
const BEAT_MS = { lock: 4200, think: 4600, offer: 5600, late: 4600, stance: 6200, vote: 5400, passed: 3800, merge: 6600, swap: 5400 };
export const durationOf = (b, last) => Math.max(BEAT_MS[b.kind] || 3500, b.quote ? 2400 + b.quote.length * 40 : 0) + (last ? 2600 : 0);

/** A query against one node, given up after 8 seconds. */
export function rpcQuery(rpc) {
  return async (params) => {
    const r = await fetch(rpc, {
      method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(8000),
      body: JSON.stringify({ jsonrpc: "2.0", id: "landing", method: "query", params: { finality: "optimistic", ...params } }),
    });
    const j = await r.json();
    if (j.error || !j.result) throw new Error("rpc");
    return j.result;
  };
}

/** A contract view on one node: `view(account, method, args)`. */
export function reader(rpc) {
  const ask = rpcQuery(rpc);
  return (account, method, args = {}) => ask({ request_type: "call_function", account_id: account, method_name: method, args_base64: btoa(JSON.stringify(args)) })
    .then((res) => JSON.parse(new TextDecoder().decode(new Uint8Array(res.result))));
}

/**
 * The latest takeover a coin's brain started (or the latest of any kind, if every bid so far was made
 * by hand) as a list of beats, plus every coin with its size before and after.
 * `coins` is list_coins (Live ones), `infos` their coin_info in the same order.
 * Returns null when no coin has absorbed another yet.
 */
export async function readReplay(view, coins, infos, params) {
  const takeovers = infos.flatMap((w) => w.absorbed.map(([target, rec]) => ({ w, target, rec })))
    .sort((a, b) => (BigInt(b.rec.at) > BigInt(a.rec.at) ? 1 : -1));
  if (!takeovers.length) return null;
  // Who proposed the bid that went through, from the winner's own record of it.
  const offers = {};
  const byBrain = async ({ w, target }) => {
    offers[w.account_id] ??= await view(w.account_id, "list_offers").catch(() => []);
    return offers[w.account_id].some((o) => o.target === target && o.status === "Executed" && o.proposer?.Brain);
  };
  let last = null, brain = false;
  for (const k of takeovers) if ((brain = await byBrain(k))) { last = k; break; }
  last ??= takeovers[0];
  const { w, rec } = last;
  const t = infos.find((i) => i.account_id === last.target);
  if (!t) return null;
  const [hw, ht] = await Promise.all([view(w.account_id, "history"), view(t.account_id, "history")]);

  // What the target was worth at the agreed rate, in the winner's coin at today's price.
  const taken = near((((BigInt(rec.max_target_amount) * BigInt(rec.rate_ppm)) / 1_000_000n) * BigInt(w.price_yocto)) / UNIT);
  const all = infos.map((i) => {
    const cap = capOf(i);
    const before = i === w ? Math.max(cap - taken, cap * 0.2) : i === t ? taken : cap;
    return { id: i.account_id, symbol: i.symbol, name: i.name, cap: i === t ? 0 : cap, before };
  });
  return { winner: w.account_id, target: t.account_id, coins: all, beats: beats(w, t, hw, ht, params, brain) };
}

// Turns the two logs into beats, told around the one bid that went through. Each beat:
// { kind, coin (who acts), text, quote?, by?, ...its numbers for the arena's readouts }. Repeated locks
// and votes are told as one beat. `brain` says whether the winner's brain made the bid or a holder did.
function beats(w, t, hw, ht, params, brain) {
  const W = `$${w.symbol}`, T = `$${t.symbol}`;
  const fee = params?.brain_fee ? fmtNear(Number(BigInt(params.brain_fee)) / YOCTO) : null;
  const at = (e) => BigInt(e.at);
  // Logs are oldest first: the last match before a moment, and every match between two.
  const lastBefore = (log, when, test) => log.filter((e) => at(e) < when && test(e)).pop();
  const between = (log, from, to, test) => log.filter((e) => at(e) > from && at(e) < to && test(e));
  const sum = (list, re) => list.reduce((n, e) => n + BigInt(e.text.match(re)?.[1] || 0), 0n);

  // The holders' approval names the bid as "<winner>#<n>"; votes and the target brain's stance name it the same way.
  const mergedAt = BigInt(w.absorbed.find(([a]) => a === t.account_id)[1].at) + 1n;
  const passed = lastBefore(ht, mergedAt, (e) => e.event === "offer_passed" && e.text.includes(`${w.account_id}#`));
  const offer = passed && lastBefore(hw, at(passed), (e) => e.event === "offer_made" && e.text.includes(t.account_id));
  const bid = passed?.text.match(/approved (\S+#\d+)/)?.[1];
  const absorb = hw.find((e) => e.event === "absorb" && e.text.includes(t.account_id) && at(e) >= mergedAt - 1n);
  if (!offer || !bid || !absorb) return [];
  const offerAt = at(offer), passedAt = at(passed);
  const out = [];
  const add = (e, beat) => out.push({ at: e.at, ...beat });
  let m;

  const lock = lastBefore(ht, offerAt, (e) => e.event === "lock");
  if (lock && (m = lock.text.match(/locked (\d+) tokens/))) {
    add(lock, { kind: "lock", coin: t.account_id, amount: tokens(m[1]), text: `A holder locks ${tokens(m[1])} ${T} before the bid. Only tokens locked before a bid can vote on it.` });
  }
  const thought = brain && lastBefore(hw, offerAt, (e) => e.event === "thought");
  if (thought) {
    const woke = lastBefore(hw, at(thought), (e) => e.event === "think");
    add(thought, { kind: "think", coin: w.account_id, by: `${W}'s brain`, quote: thought.text, fee: woke ? fee : null,
      text: `${woke ? `Someone ${fee ? `pays ${fee} to wake` : "wakes"}` : "Then"} ${W}'s brain. It sizes up its rivals.` });
  }
  if ((m = offer.text.match(/at ([\d.]+) per token \(([+-]?\d+) bps vs fair\): "(.*)"$/s))) {
    const bps = Number(m[2]);
    add(offer, { kind: "offer", coin: w.account_id, by: brain ? `${W}'s brain` : `A ${W} holder`, quote: m[3], rate: +m[1], bps,
      text: `${brain ? W : `A ${W} holder, by hand,`} bids for ${T}: ${(+m[1]).toFixed(4)} ${W} per ${T}, ${(Math.abs(bps) / 100).toFixed(1)}% ${bps >= 0 ? "over" : "under"} the fair rate.` });
  } else return [];
  const late = between(ht, offerAt, passedAt, (e) => e.event === "lock");
  if (late.length) {
    add(late[0], { kind: "late", coin: t.account_id, count: late.length, amount: tokens(sum(late, /locked (\d+) tokens/)),
      text: `${late.length === 1 ? "A late buyer locks" : `${late.length} late buyers lock`} ${tokens(sum(late, /locked (\d+) tokens/))} ${T} after the bid. The contract won't count those tokens on it.` });
  }
  const stance = between(ht, offerAt, passedAt, (e) => e.event === "stance" && e.text.includes(`on ${bid}:`)).pop();
  const said = stance?.text.match(/vote (YES|NO) on \S+: "(.*)"$/s);
  if (said) {
    const woke = between(ht, offerAt, at(stance), (e) => e.event === "think").length > 0;
    add(stance, { kind: "stance", coin: t.account_id, by: `${T}'s brain`, quote: said[2], no: said[1] === "NO", say: said[1],
      text: `${woke ? "Someone wakes" : "Then"} ${T}'s brain. It tells its holders to vote ${said[1]}.` });
  }
  const votes = between(ht, offerAt, passedAt, (e) => e.event === "vote" && e.text.includes(`on ${bid} with`));
  if (votes.length) {
    const yes = sum(votes.filter((e) => e.text.includes("voted YES")), /with (\d+) tokens/), no = sum(votes.filter((e) => e.text.includes("voted NO")), /with (\d+) tokens/);
    // Worth saying when the holders went against their own coin's brain.
    const overruled = said && (said[1] === "NO") === yes > no ? " The holders decide, not the brain." : "";
    add(votes[0], { kind: "vote", coin: t.account_id, yes: yes >= no, voters: votes.length, yesTokens: tokens(yes), noTokens: tokens(no),
      yesShare: yes + no > 0n ? Number((yes * 10000n) / (yes + no)) / 10000 : 0, approval: params?.approval_bps ? params.approval_bps / 10000 : null,
      text: votes.length === 1
        ? `A holder votes ${yes ? "YES" : "NO"} with ${tokens(yes || no)} tokens locked before the bid.${overruled}`
        : `${votes.length} holders vote: ${tokens(yes)} YES${no ? `, ${tokens(no)} NO` : ""}, all with tokens locked before the bid.${overruled}` });
  }
  add(passed, { kind: "passed", coin: t.account_id, text: `Time's up and the vote has passed. Anyone can now tell ${W} to carry it out.` });
  if ((m = absorb.text.match(/absorbed ([\d.]+) NEAR/))) {
    add(absorb, { kind: "merge", coin: w.account_id, near: +m[1], text: `${W} swallows ${T}. ${fmtNear(+m[1])} of ${T}'s curve and treasury moves into ${W}.` });
  } else return [];
  const swaps = ht.filter((e) => e.event === "convert" && at(e) >= mergedAt - 1n);
  if (swaps.length) {
    const rate = (Number(w.absorbed.find(([a]) => a === t.account_id)[1].rate_ppm) / 1e6).toFixed(4);
    add(swaps[0], { kind: "swap", coin: t.account_id, count: swaps.length, amount: tokens(sum(swaps, /converted (\d+) tokens/)), rate: +rate,
      text: `${swaps.length === 1 ? "Its holder swaps" : `${swaps.length} holders swap`} ${tokens(sum(swaps, /converted (\d+) tokens/))} ${T} for ${W} at ${rate}. ${T} lives on inside ${W}.` });
  }
  return out.sort((a, b) => (BigInt(a.at) < BigInt(b.at) ? -1 : 1)).map(({ at: _, ...b }) => b);
}
