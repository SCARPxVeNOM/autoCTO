// Rules view: the limits every coin lives by, and the simulation they were picked with.
import { useEffect, useState } from "react";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { More, SectionHead } from "@/components/common";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cfg, fmtNear, mins, state } from "@/lib/chain";

const pct = (bps) => `${bps / 100}%`;

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
    <div className="mb-4 px-6 max-sm:px-4">
      <p className="mb-3 max-w-[80ch] text-[13px] text-muted-foreground">Each cell: good deals that pass / bad deals that pass, over {c.attacks} whale attacks per row. Chosen: the most conservative row within 0.05 of the best score, <b className="text-foreground">quorum {pct(c.quorumBps)}, approval {pct(c.approvalBps)}, buyer veto {pct(c.vetoBps)}</b>.</p>
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

export default function Rules() {
  const p = state.params;
  const [sim, setSim] = useState(null);
  useEffect(() => {
    fetch("data/sim.json", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).then(setSim).catch(() => {});
  }, []);
  const cards = [
    [mins(p.vote_period_sec), "to vote", "Each bid is open for this long. Nothing happens before the vote ends."],
    [pct(p.quorum_bps), "must take part", "At least this share of the target coin has to vote, or the bid fails."],
    [pct(p.approval_bps), "must say yes", "Of the votes cast. A simple majority is not enough."],
    [pct(p.veto_bps), "can block", "If this share of the bidder's own holders vetoes, the bid is off."],
    [`±${p.max_premium_bps / 100}%`, "price limit", "A bid can be at most this far above or below the fair rate, so nobody is robbed by a silly price."],
    [mins(p.newborn_protection_sec), "newborn protection", "A new coin cannot be bid for until this much time has passed."],
    [`${p.max_offers_per_day} a day`, "bids per coin", `And a ${mins(p.rebid_cooldown_sec)} wait before bidding for the same coin again. No spam.`],
    [pct(p.trade_fee_bps), "trading fee", "Goes to the coin's own treasury, which pays for its brain. No team cut."],
    ...(p.tender_threshold_bps ? [[pct(p.tender_threshold_bps), "for a tender", `A tender for an outside token only happens if this share of its supply is deposited within ${mins(p.tender_period_sec)}. Otherwise everyone is refunded.`]] : []),
    ["0 keys", "no owner", "No account can change a coin's code, rules or funds after launch."],
  ];
  const exact = [
    `vote ${p.vote_period_sec}s`, ...(p.reveal_period_sec > 0 ? [`sealed votes · reveal ${p.reveal_period_sec}s`] : []),
    `quorum ${pct(p.quorum_bps)}`, `approval ${pct(p.approval_bps)}`, `buyer veto ${pct(p.veto_bps)}`,
    `premium ≤ ${pct(p.max_premium_bps)}`, `discount ≤ ${pct(p.max_discount_bps)}`, `dilution ≤ ${pct(p.max_dilution_bps)}`,
    `newborn protection ${p.newborn_protection_sec}s`, `rebid cooldown ${p.rebid_cooldown_sec}s`, `${p.max_offers_per_day} bids/day`,
    `brain ${fmtNear(p.brain_fee)}/think, ≤ ${fmtNear(p.brain_daily_cap)}/day`, `fee ${pct(p.trade_fee_bps)}`,
    ...(p.tender_threshold_bps ? [`tender: ${pct(p.tender_threshold_bps)} of outside supply in ${p.tender_period_sec}s, backed by ${pct(p.quorum_bps)} of holders, mints ≤ ${pct(p.tender_max_dilution_bps)}`] : []),
    "no owner · no setters",
  ];
  return (
    <>
      <section id="rules" className="pb-8 pt-6">
        <SectionHead title="Rules" />
        <div className="grid gap-4 px-6 max-sm:px-4">
          <p className="max-w-[72ch]">The AI only <b>proposes</b>. The contract enforces these limits, and nobody can change them. <span className="text-muted-foreground">Tap a card for what it means.</span></p>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,150px),1fr))] gap-2.5">
            {cards.map(([v, k, t]) => (
              <Tooltip key={k}>
                <TooltipTrigger asChild>
                  <Card tabIndex={0} className="cursor-help content-start gap-0.5 rounded-2xl p-3.5 shadow-none">
                    <b className="font-mono text-2xl font-medium leading-tight tracking-tight">{v}</b>
                    <span className="font-display text-[14.5px] font-semibold">{k}</span>
                  </Card>
                </TooltipTrigger>
                <TooltipContent className="max-w-[260px] text-[13px] leading-snug">{t}</TooltipContent>
              </Tooltip>
            ))}
          </div>
          <Accordion type="single" collapsible className="rounded-2xl border px-4">
            <AccordionItem value="exact" className="border-b-0">
              <AccordionTrigger className="font-display text-[15px] font-semibold">All rules, exact values</AccordionTrigger>
              <AccordionContent className="grid gap-3">
                <div className="flex flex-wrap gap-1.5">{exact.map((t) => <Badge key={t} variant="secondary" className="whitespace-normal font-mono font-normal">{t}</Badge>)}</div>
                <p className="break-all font-mono text-xs text-muted-foreground">launchpad {cfg.launchpad} · coin code {state.codeHash} · {typeof state.codeMode === "string" ? state.codeMode : "Global"}</p>
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </div>
      </section>
      {sim && (
        <section id="sim" className="border-t border-dashed border-line pb-8 pt-6">
          <SectionHead title="Why these numbers" note={`tested in a ${sim.days}-day simulation`} />
          <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,320px),1fr))] gap-3.5 px-6 max-sm:px-4">
            {sim.scenarios.map((s) => <Scenario key={s.title} s={s} />)}
          </div>
          {sim.sweep?.length > 0 && <More label="The full parameter sweep" className="mt-4 [&>button]:mx-6 max-sm:[&>button]:mx-4"><Sweep sim={sim} /></More>}
        </section>
      )}
    </>
  );
}
