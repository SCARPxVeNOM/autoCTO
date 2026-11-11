// Rules view: how a takeover runs, every limit in plain words, and the simulation the numbers were picked with.
import { useEffect, useState } from "react";
import { ArrowLeftRight, Brain, Coins, Globe, KeyRound, Merge, Scale, Shield, Swords, Vote } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { More, PageHead, SectionHead } from "@/components/common";
import { cfg, fmtNear, mins, state } from "@/lib/chain";

const pct = (bps) => `${bps / 100}%`;
const shortHash = (h) => (h && h.length > 16 ? `${h.slice(0, 8)}…${h.slice(-6)}` : h || "–");

// Supply of each coin over the simulated days, one line per coin.
function Scenario({ s }) {
  const W = 340, H = 170, P = 28;
  const series = Object.entries(s.supply);
  const maxY = Math.max(1, ...series.flatMap(([, v]) => v));
  const days = series[0][1].length - 1;
  const x = (d) => P + (d / days) * (W - P - 8), y = (v) => H - 20 - (v / maxY) * (H - 34);
  return (
    <Card className="gap-2 rounded-2xl p-4 shadow-none">
      <h4 className="text-[15px] font-semibold">{s.title}</h4>
      <div className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-[11.5px] text-muted-foreground">
        {series.map(([name], k) => <span key={name} className="inline-flex items-center gap-1.5"><i className="size-2 rounded-full" style={{ background: `var(--s${k % 6})` }} />{name}</span>)}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`supply over ${days} days`} className="block h-auto w-full text-muted-foreground">
        <line x1={P} y1={H - 20} x2={W - 8} y2={H - 20} stroke="currentColor" opacity=".35" />
        <text x={P} y={H - 6} fontSize="10" fill="currentColor">day 0</text>
        <text x={W - 8} y={H - 6} fontSize="10" textAnchor="end" fill="currentColor">day {days}</text>
        <text x="2" y="12" fontSize="10" fill="currentColor">supply (M)</text>
        {series.map(([name, v], k) => <polyline key={name} fill="none" strokeWidth="2" strokeLinejoin="round" style={{ stroke: `var(--s${k % 6})` }} points={v.map((p, d) => `${x(d).toFixed(1)},${y(p).toFixed(1)}`).join(" ")} />)}
      </svg>
      <p className="text-[13.5px] text-muted-foreground">{s.outcome}</p>
    </Card>
  );
}

// Rows: quorum × approval; columns: buyer veto. Each cell: good deals that pass / bad deals that pass.
function Sweep({ sim }) {
  const vetos = [...new Set(sim.sweep.map((r) => r.vetoBps))].sort((a, b) => a - b);
  const rows = [...new Set(sim.sweep.map((r) => `${r.quorumBps}|${r.approvalBps}`))];
  const c = sim.chosen;
  return (
    <div className="grid gap-3">
      <p className="max-w-[80ch] text-[13px] text-muted-foreground">Each cell: good deals that pass / bad deals that pass, over {c.attacks} whale attacks per row. The highlighted cell is the one in use: the most cautious setting within 0.05 of the best score.</p>
      <Card className="overflow-hidden rounded-2xl p-0 shadow-none">
        <Table className="font-mono text-xs">
          <TableHeader><TableRow className="bg-muted/60 hover:bg-muted/60"><TableHead className="text-right">quorum</TableHead><TableHead className="text-right">approval</TableHead>{vetos.map((v) => <TableHead key={v} className="text-right">veto {pct(v)}</TableHead>)}</TableRow></TableHeader>
          <TableBody>
            {rows.map((key) => {
              const [q, a] = key.split("|").map(Number);
              return (
                <TableRow key={key}>
                  <TableCell className="text-right text-muted-foreground">{pct(q)}</TableCell><TableCell className="text-right text-muted-foreground">{pct(a)}</TableCell>
                  {vetos.map((v) => {
                    const r = sim.sweep.find((x) => x.quorumBps === q && x.approvalBps === a && x.vetoBps === v);
                    if (!r) return <TableCell key={v} />;
                    const chosen = q === c.quorumBps && a === c.approvalBps && v === c.vetoBps;
                    return <TableCell key={v} title={`score ${r.score}`} className={cn("text-right", r.attackBadPasses && "text-down", chosen && "bg-primary/15 font-semibold outline-2 -outline-offset-2 outline-primary")}>
                      {Math.round(r.goodPassRate * 100)}% / {Math.round(r.badPassRate * 100)}%{r.attackBadPasses ? ` (${r.attackBadPasses} attacks won)` : ""}</TableCell>;
                  })}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}

// One group of limits: [name, value, what it means].
function Group({ icon: Icon, title, rows }) {
  return (
    <Card className="gap-0 overflow-hidden rounded-2xl p-0 shadow-none">
      <h3 className="flex items-center gap-2 border-b border-dashed border-line bg-muted/40 px-4 py-3 text-[15px] font-semibold"><Icon className="size-4 text-primary" />{title}</h3>
      <dl className="divide-y divide-dashed divide-border">
        {rows.map(([k, v, t]) => (
          <div key={k} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-0.5 px-4 py-3">
            <dt className="text-[14.5px] font-medium">{k}</dt>
            <dd className="row-span-2 self-center text-right font-mono text-[15px] font-medium">{v}</dd>
            <dd className="text-[13px] text-muted-foreground">{t}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

export default function Rules() {
  const p = state.params;
  const [sim, setSim] = useState(null);
  useEffect(() => {
    fetch("data/sim.json", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).then(setSim).catch(() => {});
  }, []);
  const sealed = p.reveal_period_sec > 0;

  const flow = [
    [Brain, "A brain bids", `It offers a rate within ${pct(p.max_discount_bps)} below to ${pct(p.max_premium_bps)} above the fair rate. The contract refuses anything outside.`],
    [Vote, "The target's holders vote", `${mins(p.vote_period_sec)} to vote. ${pct(p.quorum_bps)} of the coin must take part and ${pct(p.approval_bps)} of the votes must be yes.`],
    [Shield, "The bidder's holders can block it", `If ${pct(p.veto_bps)} of the bidder's own holders object, the bid is off.`],
    [Merge, "The coins merge", "The target's NEAR and treasury move into the bidder."],
    [ArrowLeftRight, "Holders swap over", "Holders of the absorbed coin convert to the winner at the agreed rate."],
  ];
  const groups = [
    [Vote, "Voting", [
      ["Time to vote", mins(p.vote_period_sec), "A bid stays open this long. Nothing happens before the vote ends."],
      ...(sealed ? [["Sealed votes", `${mins(p.reveal_period_sec)} reveal`, "Votes stay hidden until voting ends, so nobody can follow the crowd. Each voter then reveals theirs in this window."]] : []),
      ["Must take part", pct(p.quorum_bps), "Share of the target coin that has to vote, or the bid fails."],
      ["Must say yes", pct(p.approval_bps), "Of the votes cast. A simple majority is not enough."],
      ["Bidder's veto", pct(p.veto_bps), "Share of the bidder's own holders that can block a bid, for example when their coin is overpaying."],
      ["Votes that count", "locked first", "Only tokens locked before a bid count for it, so nobody can buy a vote at the last minute."],
    ]],
    [Swords, "Bids", [
      ["Price limit", `−${pct(p.max_discount_bps)} to +${pct(p.max_premium_bps)}`, "How far a bid's rate may be from the fair rate, so nobody is robbed by a silly price."],
      ["New tokens per takeover", `≤ ${pct(p.max_dilution_bps)}`, "The most bidder tokens one takeover may create, as a share of the bidder's supply."],
      ["Newborn protection", mins(p.newborn_protection_sec), "A new coin cannot be bid for until this much time has passed."],
      ["Bids per coin", `${p.max_offers_per_day} a day`, `After a failed bid, the same coin waits ${mins(p.rebid_cooldown_sec)} before bidding again.`],
    ]],
    [Coins, "Money", [
      ["Trading fee", pct(p.trade_fee_bps), "Goes to the coin's own treasury, which pays for its brain. There is no team cut."],
      ["One brain decision", fmtNear(p.brain_fee), "Paid by whoever wakes the brain, or by the treasury when they attach less."],
      ["Treasury's brain budget", `${fmtNear(p.brain_daily_cap)} a day`, "The most a coin's treasury may spend on thinking per day."],
    ]],
    ...(p.tender_threshold_bps ? [[Globe, "Tenders for outside tokens", [
      ["Deposits needed", pct(p.tender_threshold_bps), `Share of the outside token's supply that must be deposited within ${mins(p.tender_period_sec)}. Otherwise everyone is refunded.`],
      ["Holder backing", pct(p.quorum_bps), "Share of the bidding coin's own holders that must back the tender."],
      ["New tokens per tender", `≤ ${pct(p.tender_max_dilution_bps)}`, "The most tokens one tender may create, as a share of the coin's supply."],
    ]]] : []),
    [KeyRound, "Ownership", [
      ["Access keys", "0", "No account can change a coin's code, rules or funds after launch, including whoever launched it."],
      ["Rule changes", "none", "There is no function that changes these numbers. They are fixed for every coin."],
      ["Coin code", shortHash(state.codeHash), "Every coin runs this exact code. The Verify page checks it against the public repo."],
    ]],
  ];

  return (
    <>
      <PageHead icon={Scale} title="Rules" lede="The AI only proposes. These limits are written into every coin's contract, they are the same for every coin, and nobody can change them." />

      <section className="border-b border-dashed border-line pb-7 pt-6">
        <SectionHead title="How a takeover runs" />
        <ol className="grid gap-2.5 px-6 max-sm:px-4 sm:grid-cols-2 lg:grid-cols-5">
          {flow.map(([Icon, title, text], k) => (
            <li key={title}>
              <Card className="h-full gap-2 rounded-2xl p-4 shadow-none">
                <div className="flex items-center gap-2.5">
                  <span className="grid size-7 place-items-center rounded-full border-[1.5px] border-dashed border-primary font-mono text-[13px] font-semibold text-primary">{k + 1}</span>
                  <Icon className="size-[18px] text-muted-foreground" />
                </div>
                <b className="font-display text-[15.5px] font-semibold">{title}</b>
                <p className="text-[13.5px] text-muted-foreground">{text}</p>
              </Card>
            </li>
          ))}
        </ol>
      </section>

      <section id="rules" className="pb-8 pt-6">
        <SectionHead title="Every limit" note="enforced by the contract, whatever a brain says" />
        <div className="gap-3.5 px-6 max-sm:px-4 lg:columns-2 [&>*]:mb-3.5 [&>*]:break-inside-avoid">
          {groups.map(([icon, title, rows]) => <Group key={title} icon={icon} title={title} rows={rows} />)}
        </div>
        <p className="mt-4 break-all px-6 font-mono text-xs text-muted-foreground max-sm:px-4">launchpad {cfg.launchpad} · coin code {state.codeHash}</p>
      </section>

      {sim && (
        <section id="sim" className="border-t border-dashed border-line pb-8 pt-6">
          <SectionHead title="Why these numbers" note={`tested in a ${sim.days}-day simulation`} />
          <p className="mb-4 max-w-[72ch] px-6 text-muted-foreground max-sm:px-4">
            We replayed {sim.days} days of trading with honest holders, lowballers and whales trying to force bad deals through. With the settings in use, {Math.round(sim.chosen.goodPassRate * 100)}% of good deals pass and {Math.round(sim.chosen.badPassRate * 100)}% of bad ones do.
          </p>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,320px),1fr))] gap-3.5 px-6 max-sm:px-4">
            {sim.scenarios.map((s) => <Scenario key={s.title} s={s} />)}
          </div>
          {sim.sweep?.length > 0 && <More label="Every setting we tried" className="mt-4 px-6 max-sm:px-4"><Sweep sim={sim} /></More>}
        </section>
      )}
    </>
  );
}
