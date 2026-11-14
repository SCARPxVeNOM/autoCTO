// Deals view: takeover bids and tender offers, each said in plain words first.
import { Brain, Check, Eye, Hand, Shield, Swords, Vote } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { PlayButton } from "./Autoplay";
import { Ago, Avatar, Left, Meter, More, Pill, SectionHead, Term, useTick } from "@/components/common";
import {
  NS, act, allOffers, cfg, fmtBps, fmtRate, fmtTokens, getBallot, humanize, now, short, stanceFor, state, statusName, sym,
} from "@/lib/chain";

const Proposer = ({ pr }) => (pr.Brain
  ? <span className="inline-flex items-center gap-1"><Brain className="size-3.5" /> brain decision #{pr.Brain.decision_id}</span>
  : <span className="inline-flex items-center gap-1"><Hand className="size-3.5" /> {pr.Holder?.account_id}</span>);
// Whose words a pitch is: the coin's brain, or a holder who made the bid by hand.
const pitchFrom = (pr, C) => (pr?.Brain ? `$${C}'s brain` : `a $${C} holder`);

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
// The bidder's own holders against the bid, as a share of its supply when the bid was made.
const VetoBar = ({ B, veto, pct, mark }) => (
  <div>
    <BarLabel left={<><b className="font-medium text-down">${B} holders <Term k="veto">veto</Term> {fmtTokens(veto)}</b> · {pct.toFixed(pct > 0 && pct < 1 ? 2 : 1)}% of ${B}</>} right={`blocks at ${mark}%`} />
    <Meter parts={[[pct, "bg-down"]]} mark={mark} />
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
  // The target checks a bid when it arrives and turns it away outright if it breaks a rule:
  // then it never priced it (fair rate 0) and no vote was held.
  const refused = st === "Failed" && BigInt(o.fair_rate_ppm || 0) === 0n;
  const veto = BigInt(o.veto || 0), vetoMark = p.veto_bps / 100;
  const blockedByVeto = veto > 0n && veto * 10_000n >= bcirc * BigInt(p.veto_bps);
  // The contract names one reason. A veto over the line counts only once the vote passes, so
  // a bid voted down first never says it was vetoed too: add it.
  const why = st === "Failed" && o.status.Failed.reason;
  const reason = st === "Failed" && (refused ? `refused by $${T}`
    : why === "vetoed by our holders" ? `vetoed by $${B} holders`
    : `${why === "rejected by holders" ? `rejected by $${T} holders` : why}${blockedByVeto ? ` and vetoed by $${B} holders` : ""}`);
  const sayNow = st === "Executed" ? `Done: $${T} holders can convert.`
    : refused ? `$${T} turned it away on arrival, so no vote was held. A coin refuses a bid that breaks its rules: a rate too far from the fair one, more new $${B} than $${B}'s cap allows, a newborn target, a failed bid between the two in the last ${Math.round(p.rebid_cooldown_sec / 60)} min, or another open bid between them.`
    : st === "Failed" ? `It did not go through: ${reason}.`
    : open && blockedByVeto ? `$${B} holders have vetoed it, so it can't go through even if the vote passes.`
    : !open ? "The merge is being carried out."
    : !ended ? `Passes with ${p.approval_bps / 100}% yes.`
    : inReveal ? "Sealed votes are being revealed."
    : "Voting has ended. Anyone can finalize.";
  // What this account can do here: only lots locked before the bid count.
  const before = (coin) => (state.me.locks[coin] || []).filter((l) => BigInt(l.since) < BigInt(o.created_at)).reduce((x, l) => x + BigInt(l.amount), 0n);
  const vt = before(o.target), vb = before(o.buyer);
  const vote = (support) => act("vote", { coin: o.target, offer: key, round: o.round, support });
  // The contract takes one ballot per account and round but has no view for it: find it in
  // the coins' feeds, from this round's start (a counter-offer starts a new round).
  const roundStart = BigInt(o.vote_ends) - BigInt(p.vote_period_sec) * NS;
  const mine = (coin, event, text) => !!who && (state.history[coin] || []).some((e) => e.event === event && BigInt(e.at) >= roundStart && e.text.startsWith(`${who} ${text} `));
  const voted = mine(o.target, "vote", `voted YES on ${key}`) ? "YES" : mine(o.target, "vote", `voted NO on ${key}`) ? "NO" : null;
  const vetoed = mine(o.buyer, "veto", `vetoed our bid for ${o.target}`);
  // Only the buttons this account can use; with no account picked yet, both sides are shown.
  const canVote = (!who || vt > 0n) && !voted, canVeto = (!who || vb > 0n) && !vetoed;
  return (
    <DealCard live={open}>
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
        <span className="inline-flex flex-wrap items-baseline gap-2 font-display text-[19px] font-semibold"><b>${B}</b><i className="font-sans text-[13px] font-normal not-italic text-muted-foreground">bids for</i><b>${T}</b></span>
        <Pill tone={tone} className="whitespace-normal">{st === "Failed" ? `failed: ${reason}` : st.toLowerCase()}</Pill>
        {open && !ended && <span className="ml-auto font-mono text-[13px] font-medium"><Left ns={o.vote_ends} /></span>}
        {open && inReveal && <span className="ml-auto font-mono text-[13px] font-medium">reveal <Left ns={revealEnds} /></span>}
      </div>
      <p className="text-[15px]">1 ${T} → <b className="font-mono font-medium">{fmtRate(o.rate_ppm)}</b> ${B}{refused ? "." : <>, <span className={prem >= 0 ? "text-up" : "text-down"}>{Math.abs(prem).toFixed(1)}% {prem >= 0 ? "above" : "below"}</span> today's price.</>} <span className="text-muted-foreground">{sayNow}</span></p>
      {open && !ended && who && (voted
        ? <Move icon={Check}>You voted <b>{voted}</b> with {fmtTokens(vt)} ${T}. They stay locked until the vote ends.</Move>
        : vetoed ? <Move icon={Check}>You vetoed this bid with {fmtTokens(vb)} ${B}. They stay locked until the vote ends.</Move>
        : vt > 0n ? <Move can icon={Vote}>You can vote with {fmtTokens(vt)} ${T}.</Move>
        : vb > 0n ? <Move can icon={Shield}>You can veto with {fmtTokens(vb)} ${B}.</Move>
        : <Move icon={Eye}>Watching only: nothing locked before this bid.</Move>)}
      {!refused && <div>
        <BarLabel left={<><b className="font-medium text-up">yes {fmtTokens(yes)}</b> · <b className="font-medium text-down">no {fmtTokens(no)}</b>{(sealedMode || sealed > 0n) && <> · sealed {fmtTokens(sealed)} (direction hidden)</>}</>}
          right={<><Term k="quorum">needs</Term> {quorum}% to vote</>} />
        <Meter parts={[[pct(yes), "bg-up"], [pct(no), "bg-down"], [pct(sealed), "bg-muted-foreground/50"]]} mark={quorum} />
      </div>}
      {veto > 0n && <VetoBar B={B} veto={veto} pct={pct(veto, bcirc)} mark={vetoMark} />}
      <div className="flex flex-wrap items-center gap-2 empty:hidden">
        {open && !ended && canVote && (ballot
          ? <span className="text-[12.5px] text-muted-foreground">You sealed <b>{ballot.support ? "YES" : "NO"}</b>. Come back to reveal it when the vote ends.</span>
          : <>
            <Button className="rounded-full btn-up" disabled={state.acting} onClick={() => vote(true)}>{sealedMode ? "Seal YES" : "Vote YES"}</Button>
            <Button className="rounded-full btn-down" disabled={state.acting} onClick={() => vote(false)}>{sealedMode ? "Seal NO" : "Vote NO"}</Button>
          </>)}
        {open && !ended && canVeto && <Button variant="outline" className="rounded-full" disabled={state.acting} onClick={() => act("veto", { coin: o.buyer, id: o.id })}>Veto (as ${B} holder)</Button>}
        {open && o.counter && <Button variant="outline" className="rounded-full" disabled={state.acting} onClick={() => act("accept_counter", { coin: o.buyer, id: o.id, rate: o.counter.rate_ppm })}>Accept counter</Button>}
        {open && inReveal && (ballot
          ? <Button className="rounded-full" disabled={state.acting} onClick={() => act("reveal", { coin: o.target, offer: key, round: o.round })}>Reveal my {ballot.support ? "YES" : "NO"} vote</Button>
          : <span className="text-[12.5px] text-muted-foreground">Reveal window: sealed votes count only once their voters reveal them.</span>)}
        {open && ended && canFinalize && <Button className="rounded-full" disabled={state.acting} onClick={() => act("finalize", { coin: o.target, offer: key })}>Finalize</Button>}
      </div>
      <More label="Pitches and terms">
        <div className="flex flex-wrap gap-x-[18px] gap-y-2">
          <TermCell label={<Term k="rate" />}><Num>{fmtRate(o.rate_ppm)}</Num> ${B} per ${T}</TermCell>
          <TermCell label={<Term k="fair rate" />}><Num>{refused ? "–" : fmtRate(o.fair_rate_ppm)}</Num></TermCell>
          <TermCell label={<Term k="premium" />}>{refused ? <Num>–</Num> : <Num className={o.premium_bps >= 0 ? "text-up" : "text-down"}>{fmtBps(o.premium_bps)}</Num>}</TermCell>
          <TermCell label="round"><Num>{o.round}</Num></TermCell>
          <TermCell label="proposed by"><Proposer pr={o.proposer} /></TermCell>
        </div>
        <Pitch who={`pitch from ${pitchFrom(o.proposer, B)} · an ad, not a fact`}>“{humanize(o.pitch)}”</Pitch>
        {o.counter && <Pitch who={`counter from $${T}: ${fmtRate(o.counter.rate_ppm)}`}>“{humanize(o.counter.pitch)}”</Pitch>}
        {stance && <Pitch brain who={`what $${T}'s brain tells its holders`}>{humanize(stance)}</Pitch>}
        {veto === 0n && !refused && <VetoBar B={B} veto={veto} pct={0} mark={vetoMark} />}
      </More>
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
        <span className="inline-flex flex-wrap items-baseline gap-2 font-display text-[19px] font-semibold"><b>${C}</b><i className="font-sans text-[13px] font-normal not-italic text-muted-foreground">tenders for</i><b className="break-all font-mono text-sm font-medium">{t.token}</b></span>
        <Pill tone={tone} className="whitespace-normal">{st === "Failed" ? `failed: ${t.status.Failed.reason}` : st.toLowerCase()}</Pill>
        {open && !ended && <span className="ml-auto font-mono text-[13px] font-medium"><Left ns={t.deadline} /></span>}
      </div>
      <p className="text-[15px]">1 {short(t.token)} → <b className="font-mono font-medium">{fmtRate(t.rate_ppm)}</b> ${C}. <Term k="tender">All or nothing</Term> at {share(t.threshold)} of its supply. <span className="text-muted-foreground">{sayNow}</span></p>
      <div>
        <BarLabel left={`deposited ${share(t.deposited)} of supply`} right={`needs ${share(t.threshold)} · cap ${share(t.max_deposit)}`} />
        <Meter parts={[[pct(t.deposited, cap), "bg-up"]]} mark={pct(t.threshold, cap)} />
      </div>
      <div className="flex flex-wrap items-center gap-2 empty:hidden">
        {open && !ended && <>
          <Button className="rounded-full btn-up" disabled={state.acting} onClick={() => go("back_tender")}>Back (as ${C} holder)</Button>
          <Button variant="outline" className="rounded-full" disabled={state.acting} onClick={() => go("veto_tender")}>Veto (as ${C} holder)</Button>
        </>}
        {ended && <Button className="rounded-full" disabled={state.acting} onClick={() => go("settle_tender")}>Settle</Button>}
        {(st === "Succeeded" || st === "Failed") && <Button variant="outline" className="rounded-full" disabled={state.acting} onClick={() => go("claim_tender")}>{st === "Succeeded" ? `Claim $${C}` : "Claim refund"}</Button>}
      </div>
      <More label="Pitch and backing">
        <div className="text-[12.5px] text-muted-foreground"><Proposer pr={t.proposer} /> · <Ago ns={t.created_at} /></div>
        <Pitch who={`pitch from ${pitchFrom(t.proposer, C)}`}>“{humanize(t.pitch)}”</Pitch>
        <div>
          <BarLabel left={<>${C} holders <Term k="backing" /> {fmtTokens(backing)}</>} right={`needs ${p.quorum_bps / 100}% of ${fmtTokens(bsupply)}`} />
          <Meter parts={[[pct(backing, bsupply), "bg-up"]]} mark={p.quorum_bps / 100} />
        </div>
        <div>
          <BarLabel left={`$${C} veto ${fmtTokens(t.veto)}`} right={`blocks at ${p.veto_bps / 100}%`} />
          <Meter parts={[[pct(t.veto, bsupply), "bg-down"]]} mark={p.veto_bps / 100} />
        </div>
      </More>
    </DealCard>
  );
}

// Who has eaten whom so far, and how many of the absorbed coin's holders have swapped over.
function FoodChain() {
  const rows = [];
  for (const { account_id: a } of state.coins) for (const [t, m] of state.info[a]?.absorbed || []) rows.push({ a, t, m });
  if (!rows.length) return null;
  return (
    <div className="mb-5 border-y border-dashed border-line">
      <div className="flex flex-wrap items-stretch">
        <div className="flex items-center gap-2 px-6 py-3 font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground max-sm:basis-full max-sm:px-4 max-sm:pb-0"><Swords className="size-3.5 text-primary" /> Food chain</div>
        {rows.map(({ a, t, m }) => {
          const max = BigInt(m.max_target_amount || 0) || 1n;
          const done = Math.min(100, Number((BigInt(m.converted || 0) * 1000n) / max) / 10);
          return (
            <div key={`${a}|${t}`} className="flex min-w-0 items-center gap-3 border-dashed border-border px-5 py-3 sm:border-l max-sm:px-4">
              <span className="flex items-center"><Avatar symbol={sym(a)} icon={state.info[a]?.icon} size={34} /><Avatar symbol={sym(t)} icon={state.info[t]?.icon} size={24}className="-ml-2 opacity-60 ring-2 ring-background grayscale" /></span>
              <span className="min-w-0 text-[13.5px]"><b className="font-display font-semibold">${sym(a)}</b> <span className="text-muted-foreground">ate</span> <b className="font-display font-semibold">${sym(t)}</b>
                <span className="block font-mono text-[11.5px] text-muted-foreground">{fmtRate(m.rate_ppm)} each · {done.toFixed(done < 10 ? 1 : 0)}% swapped</span></span>
            </div>
          );
        })}
      </div>
    </div>
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
      <SectionHead title="Deals" note="takeovers, live and finished"><PlayButton className="ml-auto max-sm:ml-0" /></SectionHead>
      <FoodChain />
      {!offers.length && !tenders.length
        ? <p className="px-6 text-muted-foreground max-sm:px-4">No deals yet. Open a coin in the Market and press <b>Think</b>{cfg.dev_key ? <>, or press <b>Play a takeover for me</b> above</> : ""}.</p>
        : <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,440px),1fr))] gap-3.5 px-6 max-sm:px-4">
          {offers.map((o) => <Offer key={`${o.buyer}#${o.id}`} o={o} />)}
          {tenders.map(({ coin, t }) => <Tender key={`${coin}|${t.id}`} coin={coin} t={t} />)}
        </div>}
    </section>
  );
}
