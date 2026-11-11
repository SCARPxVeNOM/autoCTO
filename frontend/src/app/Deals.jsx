// Deals view: takeover bids and tender offers, each said in plain words first.
import { Brain, Eye, Hand, Shield, Vote } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { Ago, Left, Meter, Pill, SectionHead, Term, useTick } from "@/components/common";
import {
  NS, act, allOffers, fmtBps, fmtRate, fmtTokens, getBallot, humanize, now, short, stanceFor, state, statusName, sym,
} from "@/lib/chain";

const Proposer = ({ pr }) => (pr.Brain
  ? <span className="inline-flex items-center gap-1"><Brain className="size-3.5" /> brain decision #{pr.Brain.decision_id}</span>
  : <span className="inline-flex items-center gap-1"><Hand className="size-3.5" /> {pr.Holder?.account_id}</span>);

const TermCell = ({ label, children }) => (
  <span className="inline-block text-[13px] text-muted-foreground"><small className="block text-[11.5px]">{label}</small>{children}</span>
);
const Num = ({ className, ...p }) => <b className={cn("font-mono text-sm font-medium text-foreground", className)} {...p} />;
const Pitch = ({ who, brain, children }) => (
  <div className={cn("break-words rounded-xl px-3 py-2 text-sm text-muted-foreground", brain ? "bg-primary/[0.08]" : "bg-muted/70")}>
    <div className="font-mono text-[11px] font-medium uppercase tracking-wide">{who}</div>{children}
  </div>
);
const BarLabel = ({ left, right }) => <div className="mb-1 flex flex-wrap justify-between gap-x-3 gap-y-1 text-[12.5px] text-muted-foreground"><span>{left}</span><span>{right}</span></div>;
const Move = ({ can, icon: Icon, children }) => (
  <div className={cn("flex items-start gap-2 rounded-xl border border-dashed px-3 py-2 text-[13.5px]", can ? "border-up/50 bg-up/[0.07] text-foreground" : "border-line text-muted-foreground")}>
    <Icon className="mt-0.5 size-4 flex-none" /><span>{children}</span>
  </div>
);
const DealCard = ({ live, children }) => (
  <Card className={cn("min-w-0 content-start gap-3 rounded-[20px] p-[18px] shadow-none", live && "border-primary/45 ring-[3px] ring-primary/10")}>{children}</Card>
);

function Offer({ o }) {
  const p = state.params, who = state.actor, t = now();
  const sealedMode = p.reveal_period_sec > 0;
  const st = statusName(o.status), key = `${o.buyer}#${o.id}`;
  const circ = BigInt(o.target_market?.circulating || 1) || 1n;
  const yes = BigInt(o.yes), no = BigInt(o.no), sealed = BigInt(o.sealed || 0);
  const pct = (x, of = circ) => Math.min(100, Number((BigInt(x) * 10000n) / of) / 100);
  const quorum = p.quorum_bps / 100;
  const bcirc = BigInt(o.buyer_market?.circulating || 1) || 1n;
  const open = st === "Open", ended = BigInt(o.vote_ends) <= t;
  // With sealed votes, finalize waits for the reveal window too.
  const revealEnds = BigInt(o.vote_ends) + BigInt(p.reveal_period_sec || 0) * NS;
  const canFinalize = t >= revealEnds, inReveal = sealedMode && ended && !canFinalize;
  const ballot = sealedMode && who ? getBallot(key, o.round, who) : null;
  const tone = { Open: "up", Executing: "brand", Sending: "brand", Executed: "muted", Failed: "down" }[st] || "muted";
  const stance = stanceFor(o);
  const B = sym(o.buyer), T = sym(o.target), prem = o.premium_bps / 100;
  const sayNow = st === "Executed" ? `Done: $${T} is now part of $${B}. Its holders can convert.`
    : st === "Failed" ? `It did not go through: ${o.status.Failed.reason}.`
    : !open ? "The merge is being carried out."
    : !ended ? `Voting is open. It passes if at least ${quorum}% of $${T} votes and ${p.approval_bps / 100}% of the votes say yes.`
    : inReveal ? "Voting has ended. Sealed votes are being revealed."
    : "Voting has ended. Anyone can press Finalize to count the votes.";
  // What this account can do here: only lots locked before the bid count.
  const before = (coin) => (state.me.locks[coin] || []).filter((l) => BigInt(l.since) < BigInt(o.created_at)).reduce((x, l) => x + BigInt(l.amount), 0n);
  const vt = before(o.target), vb = before(o.buyer);
  const vote = (support) => act("vote", { coin: o.target, offer: key, round: o.round, support });
  return (
    <DealCard live={open}>
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
        <span className="inline-flex flex-wrap items-baseline gap-2 font-display text-[19px] font-semibold"><b>${B}</b><i className="font-sans text-[13px] font-normal not-italic text-muted-foreground">bids for</i><b>${T}</b></span>
        <Pill tone={tone} className="whitespace-normal">{st === "Failed" ? `failed: ${o.status.Failed.reason}` : st.toLowerCase()}</Pill>
        <span className="inline-flex items-center gap-1 text-[12.5px] text-muted-foreground"><Proposer pr={o.proposer} /> · <Ago ns={o.created_at} /></span>
      </div>
      <p className="text-[15px]"><b>${B}</b> wants to absorb <b>${T}</b>. Each ${T} would become {fmtRate(o.rate_ppm)} ${B}, <span className={prem >= 0 ? "text-up" : "text-down"}>{Math.abs(prem).toFixed(1)}% {prem >= 0 ? "more" : "less"}</span> than it is worth today. <span className="text-muted-foreground">{sayNow}</span></p>
      {open && !ended && who && (vt > 0n
        ? <Move can icon={Vote}>You have {fmtTokens(vt)} ${T} locked from before this bid, so you can vote.</Move>
        : vb > 0n ? <Move can icon={Shield}>You have {fmtTokens(vb)} ${B} locked: you can veto if you think ${B} is overpaying.</Move>
        : <Move icon={Eye}>You have no ${T} or ${B} that was locked before this bid, so you can only watch this one. Lock tokens now to have a say in the next.</Move>)}
      <div className="flex flex-wrap gap-x-[18px] gap-y-2">
        <TermCell label={<Term k="rate" />}><Num>{fmtRate(o.rate_ppm)}</Num> ${B} per ${T}</TermCell>
        <TermCell label={<Term k="fair rate" />}><Num>{fmtRate(o.fair_rate_ppm)}</Num></TermCell>
        <TermCell label={<Term k="premium" />}><Num className={o.premium_bps >= 0 ? "text-up" : "text-down"}>{fmtBps(o.premium_bps)}</Num></TermCell>
        <TermCell label="round"><Num>{o.round}</Num></TermCell>
        {open && !ended && <TermCell label="vote"><Num><Left ns={o.vote_ends} /></Num></TermCell>}
        {open && inReveal && <TermCell label="reveal window"><Num><Left ns={revealEnds} /></Num></TermCell>}
      </div>
      <Pitch who={`pitch from $${B}'s brain · an ad, not a fact`}>“{humanize(o.pitch)}”</Pitch>
      {o.counter && <Pitch who={`counter from $${T}: ${fmtRate(o.counter.rate_ppm)}`}>“{humanize(o.counter.pitch)}”</Pitch>}
      {stance && <Pitch brain who={`what $${T}'s brain tells its holders`}>{humanize(stance)}</Pitch>}
      <div>
        <BarLabel left={<><b className="font-medium text-up">yes {fmtTokens(yes)}</b> · <b className="font-medium text-down">no {fmtTokens(no)}</b>{(sealedMode || sealed > 0n) && <> · sealed {fmtTokens(sealed)} (direction hidden)</>}</>}
          right={<><Term k="quorum">needs</Term> {quorum}% of {fmtTokens(circ)} to vote</>} />
        <Meter parts={[[pct(yes), "bg-up"], [pct(no), "bg-down"], [pct(sealed), "bg-muted-foreground/50"]]} mark={quorum} />
      </div>
      <div>
        <BarLabel left={<>${B} holders <Term k="veto">against</Term> {fmtTokens(o.veto || 0)}</>} right={`blocked at ${p.veto_bps / 100}%`} />
        <Meter parts={[[pct(o.veto || 0, bcirc), "bg-down"]]} mark={p.veto_bps / 100} />
      </div>
      <div className="flex flex-wrap items-center gap-2 empty:hidden">
        {open && !ended && (ballot
          ? <span className="text-[12.5px] text-muted-foreground">You sealed <b>{ballot.support ? "YES" : "NO"}</b>. Come back to reveal it when the vote ends.</span>
          : <>
            <Button className="rounded-full bg-up text-white hover:bg-up/90 dark:text-[#04261a]" disabled={state.acting} onClick={() => vote(true)}>{sealedMode ? "Seal YES" : "Vote YES"}</Button>
            <Button className="rounded-full bg-down text-white hover:bg-down/90 dark:text-[#2b0507]" disabled={state.acting} onClick={() => vote(false)}>{sealedMode ? "Seal NO" : "Vote NO"}</Button>
          </>)}
        {open && !ended && <Button variant="outline" className="rounded-full" disabled={state.acting} onClick={() => act("veto", { coin: o.buyer, id: o.id })}>Veto (as ${B} holder)</Button>}
        {open && o.counter && <Button variant="outline" className="rounded-full" disabled={state.acting} onClick={() => act("accept_counter", { coin: o.buyer, id: o.id })}>Accept counter</Button>}
        {open && inReveal && (ballot
          ? <Button className="rounded-full" disabled={state.acting} onClick={() => act("reveal", { coin: o.target, offer: key, round: o.round })}>Reveal my {ballot.support ? "YES" : "NO"} vote</Button>
          : <span className="text-[12.5px] text-muted-foreground">Reveal window: sealed votes count only once their voters reveal them.</span>)}
        {open && ended && canFinalize && <Button className="rounded-full" disabled={state.acting} onClick={() => act("finalize", { coin: o.target, offer: key })}>Finalize</Button>}
      </div>
    </DealCard>
  );
}

// Tender offers for tokens from outside the launchpad: deposits are the vote.
function Tender({ coin, t }) {
  const p = state.params;
  const st = statusName(t.status);
  const cap = BigInt(t.max_deposit) || 1n, supply = BigInt(t.token_supply) || 1n, bsupply = BigInt(t.buyer_supply) || 1n;
  const pct = (x, of) => Math.min(100, Number((BigInt(x) * 10000n) / of) / 100);
  const share = (x) => `${(Number((BigInt(x) * 10000n) / supply) / 100).toFixed(1)}%`;
  // Holder backing: the tender also needs a quorum of the bidding coin's own supply behind it.
  const backing = BigInt(t.backing || 0);
  const open = st === "Open", ended = open && BigInt(t.deadline) <= now();
  const tone = { Open: "up", Opening: "brand", Succeeded: "muted", Failed: "down" }[st] || "muted";
  const C = sym(coin);
  const sayNow = st === "Succeeded" ? "It worked: enough was deposited. Depositors can claim their coins."
    : st === "Failed" ? `It did not go through: ${t.status.Failed.reason}. Depositors can take their tokens back.`
    : st === "Opening" ? "The brain is checking that the token's owner cannot rug it."
    : ended ? "The deadline has passed. Anyone can press Settle." : "";
  const go = (what) => act(what, { coin, id: t.id });
  return (
    <DealCard live={open}>
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
        <span className="inline-flex flex-wrap items-baseline gap-2 font-display text-[19px] font-semibold"><b>${C}</b><i className="font-sans text-[13px] font-normal not-italic text-muted-foreground">tenders for outside token</i><b className="break-all font-mono text-sm font-medium">{t.token}</b></span>
        <Pill tone={tone} className="whitespace-normal">{st === "Failed" ? `failed: ${t.status.Failed.reason}` : st.toLowerCase()}</Pill>
        <span className="inline-flex items-center gap-1 text-[12.5px] text-muted-foreground"><Proposer pr={t.proposer} /> · <Ago ns={t.created_at} /></span>
      </div>
      <p className="text-[15px]"><b>${C}</b> offers holders of the outside token <b>{short(t.token)}</b> a swap: {fmtRate(t.rate_ppm)} ${C} for each token they deposit. <Term k="tender">All or nothing</Term>: it only happens if {share(t.threshold)} of that token's supply is deposited in time. <span className="text-muted-foreground">{sayNow}</span></p>
      <div className="flex flex-wrap gap-x-[18px] gap-y-2">
        <TermCell label="rate"><Num>{fmtRate(t.rate_ppm)}</Num> ${C} per token</TermCell>
        <TermCell label="all or nothing at"><Num>{share(t.threshold)}</Num> of its supply</TermCell>
        {open && !ended && <TermCell label="deadline"><Num><Left ns={t.deadline} /></Num></TermCell>}
      </div>
      <Pitch who={`pitch from $${C}'s brain`}>“{humanize(t.pitch)}”</Pitch>
      <div>
        <BarLabel left={`deposited ${share(t.deposited)} of supply`} right={`needs ${share(t.threshold)} · cap ${share(t.max_deposit)}`} />
        <Meter parts={[[pct(t.deposited, cap), "bg-up"]]} mark={pct(t.threshold, cap)} />
      </div>
      <div>
        <BarLabel left={<>${C} holders <Term k="backing" /> {fmtTokens(backing)}</>} right={`needs ${p.quorum_bps / 100}% of ${fmtTokens(bsupply)}`} />
        <Meter parts={[[pct(backing, bsupply), "bg-up"]]} mark={p.quorum_bps / 100} />
      </div>
      <div>
        <BarLabel left={`$${C} veto ${fmtTokens(t.veto)}`} right={`blocks at ${p.veto_bps / 100}%`} />
        <Meter parts={[[pct(t.veto, bsupply), "bg-down"]]} mark={p.veto_bps / 100} />
      </div>
      <div className="flex flex-wrap items-center gap-2 empty:hidden">
        {open && !ended && <>
          <Button className="rounded-full bg-up text-white hover:bg-up/90 dark:text-[#04261a]" disabled={state.acting} onClick={() => go("back_tender")}>Back (as ${C} holder)</Button>
          <Button variant="outline" className="rounded-full" disabled={state.acting} onClick={() => go("veto_tender")}>Veto (as ${C} holder)</Button>
        </>}
        {ended && <Button className="rounded-full" disabled={state.acting} onClick={() => go("settle_tender")}>Settle</Button>}
        {(st === "Succeeded" || st === "Failed") && <Button variant="outline" className="rounded-full" disabled={state.acting} onClick={() => go("claim_tender")}>{st === "Succeeded" ? `Claim $${C}` : "Claim refund"}</Button>}
      </div>
    </DealCard>
  );
}

export default function Deals() {
  useTick();
  const offers = allOffers();
  const tenders = [];
  for (const [coin, list] of Object.entries(state.tenders)) for (const t of list) tenders.push({ coin, t });
  tenders.sort((a, b) => Number(BigInt(b.t.created_at) - BigInt(a.t.created_at)));
  return (
    <section id="deals" className="pb-8 pt-6">
      <SectionHead title="Deals" note="Takeovers in progress and finished. Pitches are written by AI brains: read them as ads, not facts." />
      {!offers.length && !tenders.length
        ? <p className="px-6 text-muted-foreground max-sm:px-4">No deals yet. Open a coin and press <b>Think</b>: its brain looks at the rivals and may make the first bid.</p>
        : <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,440px),1fr))] gap-3.5 px-6 max-sm:px-4">
          {offers.map((o) => <Offer key={`${o.buyer}#${o.id}`} o={o} />)}
          {tenders.map(({ coin, t }) => <Tender key={`${coin}|${t.id}`} coin={coin} t={t} />)}
        </div>}
    </section>
  );
}
