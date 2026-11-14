// Judges view: KillerCoins in three lines, each track's asks next to what answers them, and the
// README's claims (the takeover, the refused attacks, the keys and the code) checked live by this page.
import { ArrowUpRight, Gavel, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { PageHead, Pill } from "@/components/common";
import { recoverSigner } from "@/lib/attest";
import { NETWORK, cfg, fmtTokens, short, state, sym, view } from "@/lib/chain";
import { CHECKS as VERIFY, GROUPS, CheckRow, STATUS, Tally, useChecks } from "./Verify";

const REPO = "https://github.com/SCARPxVeNOM/killerCoins";
const TX = "https://testnet.nearblocks.io/txns/";
// The README's takeover and attacks ran on testnet's v5 launchpad.
const LAUNCHPAD = "v5.scarpxvenom.testnet";
const PEPE = `pepe.${LAUNCHPAD}`, WOJAK = `wojak.${LAUNCHPAD}`;
const onReadmeChain = () => NETWORK === "testnet" && cfg.launchpad === LAUNCHPAD;
const ELSEWHERE = { ok: null, detail: `The README's examples are on NEAR testnet, launchpad ${LAUNCHPAD}. Open this page with ?network=testnet to check them.` };
const coins = () => state.coins.map((c) => c.account_id);

// Ordinary nodes forget transactions after a few days; archival nodes keep them.
const ARCHIVAL = ["https://archival-rpc.testnet.fastnear.com", "https://archival-rpc.testnet.near.org"];
async function txStatus(hash, signer) {
  let last;
  for (const url of ARCHIVAL) {
    try {
      const j = await fetch(url, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "judges", method: "EXPERIMENTAL_tx_status", params: { tx_hash: hash, sender_account_id: signer, wait_until: "NONE" } }),
      }).then((r) => r.json());
      if (j.result) return j.result;
      last = new Error(JSON.stringify(j.error).slice(0, 120));
    } catch (e) { last = e; }
  }
  throw last;
}

/** An attack from the README's "Try to break it": its transaction, and the refusal the chain recorded. */
const refusal = (id, title, why, hash, signer, said) => ({
  id, title, why, href: TX + hash, hrefLabel: `${hash.slice(0, 8)} on nearblocks`,
  run: async () => {
    if (!onReadmeChain()) return ELSEWHERE;
    const errs = (await txStatus(hash, signer)).receipts_outcome
      .map((o) => [o.outcome.executor_id, o.outcome.status.Failure?.ActionError?.kind?.FunctionCallError?.ExecutionError])
      .filter(([, e]) => e).map(([who, e]) => [who, e.replace("Smart contract panicked: ", "")]);
    const hit = errs.find(([, e]) => e.includes(said));
    if (hit) return { ok: true, detail: `${hit[0]} refused it: "${hit[1]}"` };
    return { ok: false, detail: errs.length ? `refused for another reason: "${errs[0][1]}"` : "the transaction was not refused" };
  },
});

const TAKEOVER = [
  {
    id: "merged",
    title: "WOJAK merged into PEPE at 0.923938 PEPE per WOJAK",
    why: "Step 6 of the README's takeover, read from WOJAK's own contract.",
    run: async () => {
      if (!onReadmeChain()) return ELSEWHERE;
      const m = (await view(WOJAK, "coin_info")).status?.Merged;
      return { ok: m?.into === PEPE && m?.rate_ppm === "923938", detail: m ? `status Merged into ${m.into}, rate_ppm ${m.rate_ppm}` : "WOJAK has not merged" };
    },
  },
  {
    id: "bid",
    title: "PEPE's AI made the bid, 5% over the fair price, and no one voted against it",
    why: "Steps 2 and 5: the bid as WOJAK recorded it, with who proposed it and the count.",
    run: async () => {
      if (!onReadmeChain()) return ELSEWHERE;
      const o = (await view(WOJAK, "list_offers")).find((x) => x.buyer === PEPE && x.status === "Executed");
      if (!o) return { ok: false, detail: "WOJAK has no executed bid from PEPE" };
      const brain = o.proposer?.Brain;
      return {
        ok: !!brain && o.premium_bps === 499 && o.no === "0" && BigInt(o.yes) > 0n,
        detail: `proposed by ${brain ? `PEPE's brain (decision #${brain.decision_id})` : "a holder"} · premium ${o.premium_bps} bps · yes ${fmtTokens(o.yes)} · no ${fmtTokens(o.no)} · ${o.status}`,
      };
    },
  },
  {
    id: "signed",
    title: "The bid is an AI answer signed by NEAR AI",
    why: "Step 2: PEPE's contract checked the signature before opening the bid and stored the signer. This page recovers the signer again from the signature.",
    run: async () => {
      if (!onReadmeChain()) return ELSEWHERE;
      const d = await view(PEPE, "get_decision", { id: 0 });
      const a = JSON.parse(d.output).attest;
      const who = recoverSigner(a.text, a.signature).toLowerCase();
      return { ok: !!d.signed_by && who === d.signed_by.toLowerCase(), detail: `recovered ${who} · stored by the contract ${d.signed_by}` };
    },
  },
  {
    id: "converted",
    title: "Every WOJAK was swapped, and PEPE owes nothing",
    why: "Step 7: PEPE may mint at most what was fixed at the merge. The swaps used all of it and no more.",
    run: async () => {
      if (!onReadmeChain()) return ELSEWHERE;
      const p = await view(PEPE, "coin_info");
      const [, ab] = p.absorbed.find(([c]) => c === WOJAK) || [];
      if (!ab) return { ok: false, detail: "PEPE has not absorbed WOJAK" };
      return { ok: ab.converted === ab.max_target_amount && p.owed === "0", detail: `${fmtTokens(ab.converted)} of ${fmtTokens(ab.max_target_amount)} WOJAK converted · PEPE owes ${fmtTokens(p.owed)}` };
    },
  },
];

const REFUSALS = [
  refusal("late-vote", "A vote bought after the bid is refused", "Someone bought WOJAK after PEPE's bid, locked it and voted. Only tokens locked before a bid can vote on it.",
    "81ReYhhZtEUjEEbsHencijgY2nPFkXMhhMNYG4Hj8Hom", "tester.scarpxvenom.testnet", "no tokens locked before this offer was announced"),
  refusal("dilution", "A bid past the dilution cap is refused", "CAT bid for DOGE with more new CAT than its cap allows, and DOGE refused it.",
    "6A6di6zA9n2hEeTMjYZF5zTKuvsEKwhECcsgSZA29kJh", "5ekyftd7.try.scarpxvenom.testnet", "deal would dilute the buyer beyond its cap"),
  refusal("premium", "A bid 47% above the fair price is refused", "A PEPE holder bid for DOGE far above the fair price. A bid must sit within 30% of it.",
    "4hJrEqaUffExgZQtK4w8Zp4o2GFTrmYfbbATU2eK3jv9", "tester.scarpxvenom.testnet", "premium 4702 bps is above the cap of 3000 bps"),
  refusal("unlock", "Selling tokens that back a live vote is refused", "A DOGE holder voted NO, then tried to unlock the tokens before the vote ended.",
    "B7vUuNZWRcS2eGXJGNBVCLSpV9WZHwUKvnBCQ269U1ub", "tester.scarpxvenom.testnet", "these tokens back a vote that has not ended"),
];

const NEP141 = {
  id: "nep141",
  run: async () => {
    const all = coins();
    const specs = await Promise.all(all.map((a) => view(a, "ft_metadata").then((m) => m.spec)));
    return { ok: all.length > 0 && specs.every((s) => s === "ft-1.0.0"), detail: all.map((a, i) => `$${sym(a)} ${specs[i]}`).join(" · ") };
  },
};
const SUBACCOUNTS = {
  id: "subaccounts",
  run: async () => {
    const all = coins(), tail = `.${cfg.launchpad}`;
    const odd = all.filter((a) => !a.endsWith(tail) || a.slice(0, -tail.length).includes("."));
    return { ok: all.length > 0 && !odd.length, detail: odd.length ? `not direct sub-accounts: ${odd.join(", ")}` : `${all.length} coins under ${cfg.launchpad}: ${all.map(short).join(", ")}` };
  },
};

const code = (s) => <code className="font-mono text-[12.5px] text-foreground">{s}</code>;
// A track's ask, in its own words, and what answers it: `check` is a live check of its own,
// `refs` are checks elsewhere on this page, `links` are things to open.
const TRACKS = [
  ["Memecoins With Mechanics: the track's prompt", [
    {
      ask: "An NEP-141 token with the mechanic in the contract, not in a backend somebody could switch off.",
      how: <>Each coin is its own NEP-141 contract ({code("contracts/coin")}) with its bonding curve, locks, votes and takeovers. The keeper only calls methods anyone can call, and the refusals below come from the coins themselves.</>,
      check: NEP141, refs: ["coin-code", "late-vote"], links: [["contracts/coin", `${REPO}/tree/main/contracts/coin`]],
    },
    {
      ask: "All parameters (target, mint size, burn size) set at launch and readable by anyone. No admin key that can change them later.",
      how: <>Every limit is fixed when the launchpad is deployed and anyone can read it with {code("get_params")}. The contracts have no owner and no setters, and their accounts have no access keys.</>,
      refs: ["params", "launchpad-keys", "coin-keys"], links: [["params/testnet.json", `${REPO}/blob/main/params/testnet.json`], ["RULES.md", `${REPO}/blob/main/RULES.md`]],
    },
    {
      ask: "Sybil resistance good enough for a demo, with its limits written plainly in the README.",
      how: <>Votes count tokens locked before the bid, not accounts, so extra accounts add nothing and tokens bought after a bid add nothing. A bid by hand needs 1% of the buyer's supply locked in an earlier block. The limits: a holder who bought before the bid votes with all of it, and where sealed votes are switched on (not on testnet), one holder can split tokens across accounts and vote both ways.</>,
      refs: ["late-vote"], links: [["Limitations in the README", `${REPO}#limitations`]],
    },
    {
      ask: "A page with the current streak, today's progress and a log of every mint and burn.",
      how: <>The Market shows each coin's price, total supply and supply in circulation; Brains &amp; feed shows each coin's recent on-chain history, mints and conversions included (the contract keeps the last 64 entries). The full log is the chain's: every mint and burn emits a standard {code("ft_mint")} or {code("ft_burn")} event.</>,
      links: [["Brains & feed", "#feed"], ["PEPE's token transfers on nearblocks", `https://testnet.nearblocks.io/token/${PEPE}`]],
    },
    {
      ask: "Simulate 60 days of community behavior first and show me supply over time under a few scenarios.",
      how: <>{code("sim/simulate.mjs")} runs five 60-day scenarios on the same rules, plus 27 parameter sets against 400 random bids each, and the parameters were chosen from that sweep. The report lists each coin's circulating supply on day 0 and day 60.</>,
      links: [["sim/REPORT.md", `${REPO}/blob/main/sim/REPORT.md`], ["The simulation in the app", "#sim"]],
    },
  ]],
  ["AI Swarms: the track's prompt", [
    {
      ask: "Each agent gets its own sub-account under one parent, so every action on chain traces back to a specific agent.",
      how: <>Each coin, with its brain, is a sub-account of the launchpad. Bids, counters and stances are calls between those accounts, and each brain decision is stored by the coin that asked for it.</>,
      check: SUBACCOUNTS,
    },
    {
      ask: "A simulation mode … using scripted strategies, so the market runs without any LLM calls.",
      how: <>With no model key every brain runs fixed rules, so {code("cargo run -p autocto-demo")} and the keeper's {code("--think")} mode run the whole market with no model calls. The rules are written down in RULES.md.</>,
      links: [["RULES.md", `${REPO}/blob/main/RULES.md`], ["brain/", `${REPO}/tree/main/brain`]],
    },
    {
      ask: "A live page showing rounds, bids, clearing price and who got what.",
      how: <>Deals shows every bid with its rate against the fair price, its vote and its outcome; Brains &amp; feed shows each brain's reasoning.</>,
      links: [["Deals", "#deals"], ["Brains & feed", "#brains"]],
    },
  ]],
  ["AI Security & Defense: the track's brief", [
    {
      ask: "Give AI money without giving it the keys to everything.",
      how: <>A brain spends its coin's treasury only through the contract: a fee per thought, a daily cap and a cooldown. It holds no key, and the contract clamps every number in its answer.</>,
      refs: ["coin-keys", "params"],
    },
    {
      ask: "Spending limits, policy engines, sandboxed wallets, reputation and scam detection.",
      how: <>The caps are the policy: premium, dilution, newborn protection, cooldown, 3 bids a day. A brain will not open a tender for an outside token whose owner still holds a full-access key, and rival pitches reach the deciding model only as fixed fields, so an order hidden in a pitch never reaches it.</>,
      refs: ["premium", "dilution"],
    },
    {
      ask: "TEE attestation.",
      how: <>OutLayer runs each brain in Intel TDX, and each model answer is signed by NEAR AI and checked on chain. The README's bid has attestation job 87429.</>,
      refs: ["signed", "signature"], links: [["OutLayer job 87429", "https://app.outlayer.ai/attestation/87429?network=testnet"]],
    },
  ]],
];

// Every check on the page, in one list, so one run asks them all.
const OWN = TRACKS.flatMap(([, asks]) => asks.map((q) => q.check).filter(Boolean));
const ALL = [...OWN, ...TAKEOVER, ...REFUSALS, ...VERIFY];
const INDEX = Object.fromEntries(ALL.map((c, i) => [c.id, i]));

const goTo = (id) => document.getElementById(`check-${id}`)?.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center" });

function AskRow({ q, res }) {
  const ids = [q.check?.id, ...(q.refs || [])].filter(Boolean);
  const rs = ids.map((id) => res[INDEX[id]]);
  const ok = rs.some((r) => r?.ok === false) ? "false" : rs.some((r) => !r) ? "wait" : rs.every((r) => r.ok === true) ? "true" : "null";
  const [, tone, label] = STATUS[ok];
  const mine = q.check && res[INDEX[q.check.id]];
  return (
    <Card className="grid gap-2.5 rounded-2xl p-4 shadow-none">
      <div className="flex items-start gap-3 max-sm:flex-col">
        <blockquote className="flex-1 border-l-2 border-primary/60 pl-3 font-display text-[15px] font-medium leading-snug">“{q.ask}”</blockquote>
        {ids.length > 0 && <Pill tone={tone}>{label}</Pill>}
      </div>
      <p className="text-[13.5px] text-muted-foreground">{q.how}</p>
      {q.check && <p className="break-words rounded-lg bg-muted/60 px-2.5 py-1.5 font-mono text-[12px] text-muted-foreground">{mine ? mine.detail : "asking the chain…"}</p>}
      {(q.refs || q.links) && (
        <div className="flex flex-wrap gap-1.5">
          {q.refs?.map((id) => (
            <button key={id} type="button" onClick={() => goTo(id)} className="rounded-full border px-2.5 py-0.5 text-[12.5px] text-muted-foreground hover:bg-muted hover:text-foreground">
              checked: {ALL[INDEX[id]].title}
            </button>
          ))}
          {q.links?.map(([label, href]) => {
            const out = href.startsWith("http");
            return (
              <a key={href} href={href} target={out ? "_blank" : undefined} rel={out ? "noopener" : undefined} className="inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[12.5px] text-primary hover:bg-muted">
                {label}{out && <ArrowUpRight className="size-3" />}
              </a>
            );
          })}
        </div>
      )}
    </Card>
  );
}

const Group = ({ title, children }) => (
  <div className="grid gap-2.5">
    <h2 className="font-mono text-[11.5px] font-medium uppercase tracking-[0.08em] text-muted-foreground">{title}</h2>
    {children}
  </div>
);

export default function Judges() {
  const { res, at, run, all } = useChecks(ALL);
  const row = (c) => <CheckRow key={c.id} c={c} r={res[INDEX[c.id]]} />;
  const [memecoins, ...others] = TRACKS;
  const asks = ([title, list]) => <Group key={title} title={title}>{list.map((q) => <AskRow key={q.ask} q={q} res={res} />)}</Group>;
  return (
    <>
      <PageHead icon={Gavel} title="For judges" lede="KillerCoins in three lines, what each track asks for and what answers it, then the README's claims checked by your browser against NEAR testnet and the public repo. No server of ours is involved.">
        <Button variant="outline" className="rounded-full" onClick={run} disabled={!all}><RotateCw /> Run again</Button>
      </PageHead>
      <section id="judges" className="grid gap-6 px-6 pb-8 pt-6 max-sm:px-4">
        <Card className="gap-2 rounded-2xl p-5 shadow-none">
          <h2 className="font-display text-lg font-semibold">KillerCoins in three lines</h2>
          <ol className="grid list-decimal gap-1 pl-5 text-[15px]">
            <li>A coin's AI bids to take over a rival coin, at no more than 30% above the fair price.</li>
            <li>The rival's holders vote with tokens locked before the bid: 10% of the supply must vote, and two thirds must say yes.</li>
            <li>If it passes, the rival's liquidity and treasury move into the buyer and its holders swap at the agreed rate. No one holds a key, so the rules can't change.</li>
          </ol>
          <p className="text-[13.5px] text-muted-foreground">Try one yourself from the <a className="text-primary underline underline-offset-2" href="#market">Market</a> with a guest account, or read the <a className="text-primary underline underline-offset-2" href={REPO} target="_blank" rel="noopener">README</a>.</p>
        </Card>
        <Tally total={ALL.length} res={res} at={at} />
        {asks(memecoins)}
        <Group title="The takeover in the README">{TAKEOVER.map(row)}</Group>
        <Group title="Try to break it: each refusal, read from the chain">{REFUSALS.map(row)}</Group>
        {GROUPS.map((g, k) => <Group key={g} title={g}>{VERIFY.filter((c) => c.group === k).map(row)}</Group>)}
        {others.map(asks)}
        <p className="max-w-[72ch] text-[13px] text-muted-foreground">
          The code, key and signature checks also run in a terminal, with nothing to install: {code("node scripts/verify.mjs")}. Not checked here: the Intel and NVIDIA hardware quotes; each brain decision under <a className="text-primary underline" href="#brains">Brains</a> links to the verifiers that do.
        </p>
      </section>
    </>
  );
}
