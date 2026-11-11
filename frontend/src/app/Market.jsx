// Market view: first steps, totals, the coin table, and the selected coin with its trade ticket.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { BadgeCheck, Brain, Check, Eye, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { Ago, Avatar, Left, More, Pill, SectionHead, Term } from "@/components/common";
import {
  act, allOffers, available, cfg, coinStatus, curveReal, fetchQuote, fmtNear, fmtPct, fmtPrice, fmtRate, fmtTokens, fmtUnits,
  guideSteps, hasWallet, isMerged, liveOffer, lockedOf, marketCap, minOut, modeDec, nearNum, now, parseUnits, priceNum, sameCode,
  selectCoin, sessionChange, short, state, statusName, store, sym, tokNum,
} from "@/lib/chain";
import { curveChart, sessionChart, sparkline } from "./charts";
import { useUi } from "./ui";
import { PlayButton } from "./Autoplay";

// ---------- first steps ----------
function Guide() {
  const { go } = useUi();
  // One line by default: the next step. The five cards open on request.
  const [hidden, setHidden] = useState(() => store.get("autocto:guide-open") !== "1");
  const steps = guideSteps();
  const done = steps.filter((s) => s.done).length;
  const next = steps.findIndex((s) => !s.done);
  const toggle = () => { const h = !hidden; setHidden(h); if (h) store.del("autocto:guide-open"); else store.set("autocto:guide-open", "1"); };
  return (
    <section id="guide" className={cn("border-b border-dashed border-line", hidden ? "py-3.5" : "pb-7 pt-6")}>
      <div className={cn("flex flex-wrap items-center gap-x-4 gap-y-2 px-6 max-sm:px-4", !hidden && "mb-4")}>
        <h2 className={cn("font-semibold", hidden ? "text-base" : "text-[22px]")}>First steps</h2>
        <div className="flex items-center gap-2.5 text-[12.5px] text-muted-foreground">
          <Progress value={(done / steps.length) * 100} className="h-1.5 w-20" />{done}/{steps.length}
        </div>
        {hidden && next >= 0 && <Button size="sm" className="rounded-full" onClick={() => go(steps[next].go)}>Next: {steps[next].title}</Button>}
        <div className="ml-auto flex items-center gap-1.5"><PlayButton /><Button variant="ghost" size="sm" onClick={toggle}>{hidden ? "All steps" : "Hide"}</Button></div>
      </div>
      {!hidden && (
        <>
          <ol className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,200px),1fr))] gap-2.5 px-6 max-sm:px-4 xl:grid-cols-5">
            {steps.map((s, k) => (
              <li key={k}>
                <Card className={cn("h-full gap-1.5 rounded-2xl p-3.5 shadow-none", s.done && "border-up/35 bg-up/[0.07]", k === next && "border-primary ring-[3px] ring-primary/15")}>
                  <span className={cn("grid size-[26px] place-items-center rounded-full font-mono text-[13px] font-semibold", s.done ? "bg-up text-white" : k === next ? "border-[1.5px] border-dashed border-primary text-primary" : "border-[1.5px] border-dashed border-line text-muted-foreground")} aria-hidden="true">
                    {s.done ? <Check className="size-3.5" strokeWidth={3} /> : k + 1}
                  </span>
                  <b className="font-display text-[15.5px] font-semibold">{s.title}</b>
                  <p className="flex-1 text-[13.5px] text-muted-foreground">{s.text}</p>
                  {(!s.done || s.go === "who") && <Button size="sm" variant={k === next ? "default" : "outline"} className="mt-1 self-start rounded-full" onClick={() => go(s.go)}>{s.btn}</Button>}
                </Card>
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}

// ---------- totals ----------
function Ticker() {
  let liq = 0n, tre = 0n, cap = 0n, trading = 0;
  for (const { account_id: a } of state.coins) {
    const i = state.info[a];
    tre += BigInt(i.treasury);
    if (isMerged(i)) continue;
    trading++; liq += curveReal(i); cap += marketCap(i);
  }
  const deals = allOffers().filter(liveOffer).length
    + Object.values(state.tenders).flat().filter((t) => ["Open", "Opening"].includes(statusName(t.status))).length;
  const cells = [
    ["coins trading", <>{trading}<small className="text-xs font-normal text-muted-foreground"> of {state.coins.length}</small></>],
    ["market cap", fmtNear(cap)], ["liquidity", fmtNear(liq)], ["treasuries", fmtNear(tre)], ["live deals", String(deals)],
  ];
  return (
    <div className="grid grid-cols-2 border-b border-dashed border-line sm:grid-cols-3 lg:grid-cols-5" aria-label="Launchpad totals">
      {cells.map(([k, v]) => (
        <div key={k} className="min-w-0 border-l border-dashed border-border px-6 py-3.5 first:border-l-0 max-sm:px-4">
          <span className="block whitespace-nowrap text-[12.5px] text-muted-foreground">{k}</span>
          <b className="whitespace-nowrap font-mono text-[19px] font-medium tracking-tight">{v}</b>
        </div>
      ))}
    </div>
  );
}

// ---------- coin badges (status and takeovers are in the market table) ----------
export function CoinBadges({ a }) {
  const i = state.info[a];
  const same = sameCode(a), noKeys = state.keys[a] === 0;
  const b = "h-[19px] rounded-md px-1.5 text-[11px] font-normal";
  return (
    <>
      <Term k="0 keys" className="no-underline"><Badge variant="outline" className={cn(b, noKeys ? "border-up/45 text-up" : "border-down/45 text-down")}>{noKeys ? <><Lock /> 0 keys</> : `${state.keys[a] ?? "?"} keys`}</Badge></Term>
      <Term k="launchpad code" className="no-underline"><Badge variant="outline" className={cn(b, same ? "border-up/45 text-up" : "border-down/45 text-down")}>{same ? <><BadgeCheck /> launchpad code</> : "code ?"}</Badge></Term>
      {(i.watchlist || []).map((t) => <Term key={t} k="watchlist" className="no-underline"><Badge variant="outline" className={b}><Eye /> {short(t)}</Badge></Term>)}
    </>
  );
}
function StatusPill({ info }) {
  const [label, tone, until] = coinStatus(info);
  return <Pill tone={tone}>{label}{until && <> · <Left ns={until} /></>}</Pill>;
}

// ---------- table ----------
function MarketTable() {
  const { pointAt } = useUi();
  const who = state.me.acct;
  const pick = (a) => { selectCoin(a); pointAt("trade", "start"); };
  if (!state.coins.length) return <p className="px-6 py-4 text-muted-foreground">No coins yet. Be the first: <a className="text-primary underline" href="#launch">launch one</a>.</p>;
  const num = "text-right font-mono text-[13.5px] font-medium";
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent [&>th]:h-9 [&>th]:text-[12.5px] [&>th]:font-normal [&>th]:text-muted-foreground">
          <TableHead className="pl-6 max-sm:pl-4">Coin</TableHead><TableHead className="text-right">Price / 1M</TableHead>
          <TableHead className="text-center max-md:hidden">Session</TableHead><TableHead className="text-right max-md:hidden">Market cap</TableHead>
          <TableHead className="text-right max-lg:hidden">Liquidity</TableHead><TableHead className="text-right max-lg:hidden">Treasury</TableHead>
          <TableHead className="text-right max-sm:hidden">You hold</TableHead><TableHead className="pr-6 text-right max-sm:pr-4">Status</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {state.coins.map(({ account_id: a }) => {
          const i = state.info[a], merged = isMerged(i), ch = sessionChange(a);
          const mine = (state.me.bal[a] || 0n) + lockedOf(a);
          return (
            <TableRow key={a} tabIndex={0} role="button" aria-label={`Open $${i.symbol}`} data-state={a === state.sel ? "selected" : undefined}
              onClick={() => pick(a)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(a); } }}
              className={cn("cursor-pointer", a === state.sel && "shadow-[inset_3px_0_0_var(--primary)]")}>
              <TableCell className="py-3 pl-6 max-sm:pl-4">
                <div className={cn("flex min-w-0 items-center gap-3", merged && "opacity-60")}>
                  <Avatar symbol={i.symbol} />
                  <div className="grid min-w-0 gap-1">
                    <div className="truncate"><b className="font-display text-base font-semibold">${i.symbol}</b> <span className="text-muted-foreground">{i.name}</span></div>
                    {i.absorbed.length > 0 && <div className="flex flex-wrap items-center gap-1">{i.absorbed.map(([t]) => <Badge key={t} variant="outline" className="h-[19px] rounded-md border-dashed border-primary px-1.5 text-[11px] font-normal text-primary">ate ${sym(t)}</Badge>)}</div>}
                  </div>
                </div>
              </TableCell>
              <TableCell className={num}>{merged ? "–" : fmtPrice(priceNum(i))}</TableCell>
              <TableCell className="max-md:hidden">
                {!merged && <div className="flex items-center justify-center gap-1.5"><span dangerouslySetInnerHTML={{ __html: sparkline(a) }} />{ch != null && <span className={cn("font-mono text-xs font-medium", ch >= 0 ? "text-up" : "text-down")}>{fmtPct(ch)}</span>}</div>}
              </TableCell>
              <TableCell className={cn(num, "max-md:hidden")}>{merged ? "–" : fmtNear(marketCap(i))}</TableCell>
              <TableCell className={cn(num, "max-lg:hidden")}>{fmtNear(curveReal(i))}</TableCell>
              <TableCell className={cn(num, "max-lg:hidden")}>{fmtNear(i.treasury)}</TableCell>
              <TableCell className={cn(num, "max-sm:hidden")}>{who ? fmtTokens(mine) : "–"}</TableCell>
              <TableCell className="pr-6 text-right max-sm:pr-4"><StatusPill info={i} /></TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

// ---------- coin panel ----------
// The chart SVG for the current width, plus the note shown beside its tabs.
function useChart({ a, kind, afterNear }) {
  const box = useRef(null);
  const [w, setW] = useState(600);
  useLayoutEffect(() => {
    const ro = new ResizeObserver(([e]) => setW(Math.max(280, Math.round(e.contentRect.width))));
    ro.observe(box.current);
    return () => ro.disconnect();
  }, []);
  const i = state.info[a], H = w < 480 ? 210 : 260;
  let html = "", note = "";
  if (kind === "session") {
    html = sessionChart(a, w, H) || "";
    note = `since ${new Date(state.opened).toLocaleTimeString()}`;
  } else if (!isMerged(i)) {
    const c = curveChart(i, w, H, afterNear);
    html = c?.svg || "";
    note = c ? `buys push the price up the curve, sells bring it down` : "";
  }
  return { box, html, note, merged: kind !== "session" && isMerged(i) };
}

function CoinPanel({ a, afterNear }) {
  const [kind, setKind] = useState("curve");
  const i = state.info[a], merged = isMerged(i), ch = sessionChange(a);
  const chart = useChart({ a, kind, afterNear });
  // The market table already shows market cap, liquidity and treasury on wider screens.
  const stats = [
    ["market cap", merged ? "–" : fmtNear(marketCap(i)), "market cap", "md:hidden"], ["liquidity", fmtNear(curveReal(i)), "liquidity", "lg:hidden"],
    ["treasury", fmtNear(i.treasury), "treasury", "lg:hidden"], ["locked for votes", fmtTokens(i.total_locked), "lock"],
    ["in circulation", fmtTokens(i.circulating)], ["brain decisions", String(i.decisions)],
  ];
  const more = [
    ["total supply", fmtTokens(i.total_supply)],
    ...(BigInt(i.owed || 0) > 0n ? [["owed to converters", fmtTokens(i.owed), "convert"]] : []),
    ["brain spent", fmtNear(i.brain_spent_total), "brain"],
    ["born", <Ago ns={i.born_at} />],
  ];
  const cell = ([k, v, t, hide]) => (
    <div key={k} className={cn("px-3 py-2 shadow-[0_0_0_.5px_var(--border)]", hide)}>
      <dt className="text-xs text-muted-foreground">{t ? <Term k={t}>{k}</Term> : k}</dt><dd className="font-mono text-sm font-medium">{v}</dd>
    </div>
  );
  return (
    <div className="grid min-w-0 content-start gap-4 px-6 pb-7 pt-5 max-sm:px-4">
      <div className="grid gap-2.5">
        <div className="flex flex-wrap items-center gap-3.5">
          <Avatar symbol={i.symbol} size={52} />
          <div className="min-w-0 flex-[1_1_160px]">
            <h3 className="text-[26px] font-semibold leading-tight">${i.symbol} <span className="text-[17px] font-medium text-muted-foreground">{i.name}</span></h3>
          </div>
          <div className="ml-auto text-right max-sm:ml-0 max-sm:basis-full max-sm:text-left">
            <div className="font-mono text-[26px] font-medium leading-tight tracking-tight">{merged ? "absorbed" : fmtPrice(priceNum(i))}</div>
            <div className="text-[12.5px] text-muted-foreground">
              {!merged && <>per 1M ${i.symbol}</>}
              {ch != null && !merged && <> · <span className={cn("font-mono font-medium", ch >= 0 ? "text-up" : "text-down")}>{fmtPct(ch)}</span></>}
            </div>
          </div>
        </div>
        <p className="max-w-[70ch] text-muted-foreground">{i.persona}</p>
        <div className="flex flex-wrap items-center gap-1.5"><CoinBadges a={a} /></div>
      </div>

      <Card className="gap-0 overflow-hidden rounded-2xl p-0 shadow-none">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-dashed border-line p-2.5">
          <Tabs value={kind} onValueChange={setKind}>
            <TabsList className="h-8"><TabsTrigger value="curve" className="text-[12.5px]">Price curve</TabsTrigger><TabsTrigger value="session" className="text-[12.5px]">This session</TabsTrigger></TabsList>
          </Tabs>
          <span className="text-[12.5px] text-muted-foreground">{chart.note}</span>
        </div>
        <div ref={chart.box} className="chart min-h-[210px]">
          {chart.merged
            ? <p className="p-6 text-muted-foreground">${i.symbol} was absorbed by ${sym(i.status.Merged.into)}: its NEAR and treasury moved over, so there is no curve left to trade on. Holders convert at {fmtRate(i.status.Merged.rate_ppm)} ${sym(i.status.Merged.into)} per ${i.symbol}.</p>
            : <div dangerouslySetInnerHTML={{ __html: chart.html }} />}
        </div>
      </Card>

      <dl className="grid grid-cols-[repeat(auto-fit,minmax(130px,1fr))] overflow-hidden rounded-xl border">{stats.map(cell)}</dl>
      <More label="More numbers">
        <dl className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] overflow-hidden rounded-xl border">{more.map(cell)}</dl>
        <div className="break-all font-mono text-xs text-muted-foreground">{a}</div>
      </More>
    </div>
  );
}

// ---------- trade ticket ----------
const MODES = { buy: ["Buy", "You pay"], sell: ["Sell", "You sell"], lock: ["Lock", "You lock"], unlock: ["Unlock", "You unlock"] };
const Row = ({ k, children, big }) => (
  <div className={cn("flex items-baseline justify-between gap-3", big && "border-b border-dashed border-line pb-2")}>
    <dt className="text-muted-foreground">{k}</dt><dd className={cn("text-right font-mono font-medium", big && "text-base")}>{children}</dd>
  </div>
);

function Ticket({ a, onQuote }) {
  const { mode, setMode, amtRef } = useUi();
  const [amt, setAmt] = useState("");
  const [slip, setSlip] = useState("100");
  const [q, setQ] = useState({ quote: null, error: null });
  const i = state.info[a], s = i.symbol, merged = isMerged(i);
  const who = state.me.acct, av = available(mode, a), until = state.me.until[a] || 0n;

  // A new coin or mode starts from an empty ticket.
  useEffect(() => { setAmt(""); }, [a, mode]);
  const v = parseUnits(amt, modeDec(mode));
  const trade = mode === "buy" || mode === "sell";
  const key = `${a}|${mode}|${v ?? ""}|${state.me.registered[a]}`;
  useEffect(() => {
    setQ({ quote: null, error: null }); onQuote(null);
    if (!trade || v == null || v === 0n || (av != null && v > av)) return;
    let live = true;
    const t = setTimeout(() => {
      fetchQuote(mode, a, v)
        .then((quote) => { if (live) { setQ({ quote, error: null }); onQuote(quote); } })
        .catch((e) => { if (live) setQ({ quote: null, error: String(e.message || e).slice(0, 120) }); });
    }, 180);
    return () => { live = false; clearTimeout(t); };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  if (merged) {
    const into = i.status.Merged.into;
    return (
      <div className="grid gap-3">
        <p>${s} was absorbed by ${sym(into)} at {fmtRate(i.status.Merged.rate_ppm)} ${sym(into)} per ${s}. Convert swaps everything you hold here, in your wallet and locked, for ${sym(into)}.</p>
        <Button size="lg" className="btn-big h-[46px] w-full text-base font-semibold" disabled={state.acting} onClick={() => act("convert", { coin: a })}>Convert to ${sym(into)}</Button>
        <Position a={a} />
      </div>
    );
  }

  const hints = {
    buy: `${state.params.trade_fee_bps / 100}% fee, paid to $${s}'s own treasury.`,
    sell: "",
    lock: "Locked tokens are votes. Lock before a bid appears.",
    unlock: "",
  };
  let note = hints[mode], bad = false, ok = false;
  const quote = q.quote;
  if (amt.trim() === "") { /* keep the hint */ }
  else if (v == null || v === 0n) { note = "Enter a positive amount."; bad = true; }
  else if (av != null && v > av) { note = `More than the ${mode === "buy" ? fmtNear(av) : `${fmtTokens(av)} $${s}`} available.`; bad = true; }
  else if (mode === "unlock" && until > now()) { note = "These tokens back a vote that has not ended yet."; bad = true; }
  else if (!trade) ok = true;
  else if (q.error) { note = `No quote: ${q.error}`; bad = true; }
  else if (quote) {
    ok = quote.out > 0n;
    if (!ok) { note = "Too small to trade."; bad = true; }
    else if (mode === "buy" && state.me.registered[a] === false) note = `First buy of $${s}: ${fmtNear(state.storageMin[a] || 0n)} of this pays for your token storage.`;
  }
  let rows = null;
  if (quote && trade) {
    const spot = priceNum(i);
    const nearSide = mode === "buy" ? nearNum(v) : nearNum(quote.out), tokSide = mode === "buy" ? tokNum(quote.out) : tokNum(v);
    const avg = tokSide > 0 ? nearSide / tokSide : 0;
    const impact = spot > 0 && avg > 0 ? (mode === "buy" ? avg / spot - 1 : 1 - avg / spot) : 0;
    const recv = (x) => (mode === "buy" ? `${fmtTokens(x)} $${s}` : fmtNear(x));
    rows = (
      <dl className="grid gap-1.5 text-[13.5px]">
        <Row k="You receive" big>≈ {recv(quote.out)}</Row>
        <Row k="Your price per 1M">{fmtPrice(avg)}</Row>
        <Row k="Price impact + fee"><span className={impact > 0.05 ? "text-down" : ""}>{(impact * 100).toFixed(2)}%</span></Row>
        <Row k="You get at least">{recv(minOut(quote.out, slip))}</Row>
      </dl>
    );
  }
  const quick = mode === "buy"
    ? ["0.1", "1", "5", "10"].map((x) => [x, `${x} Ⓝ`])
    : [25, 50, 75, 100].map((p) => [av == null ? null : fmtUnits((av * BigInt(p)) / 100n, modeDec(mode)), p === 100 ? "Max" : `${p}%`]);
  const submit = async () => { if (await act(mode, { coin: a, amount: amt, slip })) setAmt(""); };
  const tone = { buy: "btn-up", sell: "btn-down", lock: "", unlock: "" }[mode];

  return (
    <div className="grid gap-3">
      <Tabs value={mode} onValueChange={setMode}>
        <TabsList className="w-full">{Object.entries(MODES).map(([m, [label]]) => <TabsTrigger key={m} value={m}>{label}</TabsTrigger>)}</TabsList>
      </Tabs>
      <label className="grid gap-1.5 rounded-2xl border border-line bg-muted/60 px-3.5 py-3 transition-shadow focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/25">
        <span className="flex flex-wrap justify-between gap-2 text-[12.5px] text-muted-foreground">
          <span>{MODES[mode][1]}</span><span>available <b className="font-mono font-medium text-foreground">{av == null ? "–" : mode === "buy" ? fmtNear(av) : fmtTokens(av)}</b></span>
        </span>
        <span className="flex items-baseline gap-2">
          <input ref={amtRef} value={amt} onChange={(e) => setAmt(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && ok && !state.acting) submit(); }}
            inputMode="decimal" placeholder="0.0" autoComplete="off" spellCheck={false}
            className="w-full flex-1 bg-transparent font-mono text-[28px] font-medium leading-tight tracking-tight outline-none placeholder:text-muted-foreground/60 max-sm:text-2xl" />
          <span className="whitespace-nowrap font-display text-sm font-semibold text-muted-foreground">{mode === "buy" ? "NEAR" : `$${s}`}</span>
        </span>
      </label>
      <div className="flex flex-wrap gap-1.5">
        {quick.map(([val, label]) => <Button key={label} type="button" variant="secondary" size="sm" className="h-7 rounded-full px-3 text-[13px]" disabled={val == null} onClick={() => setAmt(val)}>{label}</Button>)}
      </div>
      {rows}
      {trade && (
        <div className="flex items-center justify-between text-[13.5px] text-muted-foreground">
          <Term k="slippage">Max slippage</Term>
          <Select value={slip} onValueChange={setSlip}>
            <SelectTrigger size="sm" className="h-8 w-[88px] rounded-full"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="50">0.5%</SelectItem><SelectItem value="100">1%</SelectItem><SelectItem value="300">3%</SelectItem><SelectItem value="1000">10%</SelectItem></SelectContent>
          </Select>
        </div>
      )}
      <Button size="lg" className={cn("btn-big h-[46px] w-full text-base font-semibold", tone)} disabled={!ok || state.acting} onClick={submit}>{MODES[mode][0]} ${s}</Button>
      {note && <p className={cn("text-[12.5px] text-muted-foreground", bad && "text-down")}>{note}</p>}
      <Position a={a} />
      <div className="flex items-center gap-2.5 border-t border-dashed border-line pt-3.5">
        <Button id="think" variant="outline" className="flex-none rounded-full" disabled={state.acting} onClick={() => act("think", { coin: a })}><Brain /> Think</Button>
        <span className="text-[12.5px] text-muted-foreground" title={`Used ${fmtNear(i.brain_spent_today)} of ${fmtNear(state.params.brain_daily_cap)} today`}>Wake ${s}'s AI to look for a deal · {fmtNear(state.params.brain_fee)}</span>
      </div>
    </div>
  );
}

function Position({ a }) {
  const s = state.info[a].symbol, who = state.me.acct;
  const until = state.me.until[a] || 0n, lots = state.me.locks[a] || [];
  return (
    <div className="grid gap-2 border-t border-dashed border-line pt-3.5">
      <h4 className="flex flex-wrap items-baseline justify-between gap-2 text-[15px] font-semibold">Your position <span className="font-mono text-[12.5px] font-normal text-muted-foreground">{who}</span></h4>
      {!who ? (
        <p className="text-[13.5px] text-muted-foreground">{cfg.dev_key ? "No account selected." : hasWallet() ? "Connect a wallet to see your balances." : "Type your account at the top."}</p>
      ) : (
        <dl className="grid gap-1.5 text-[13.5px]">
          <Row k={`$${s} you can sell`}>{fmtTokens(state.me.bal[a] || 0n)}</Row>
          <Row k={<>${s} <Term k="lock">locked for votes</Term></>}>{fmtTokens(lockedOf(a))}</Row>
          <Row k="NEAR">{state.me.near == null ? "–" : fmtNear(state.me.near)}</Row>
          {until > now() && <Row k="backing a vote"><Left ns={until} /></Row>}
        </dl>
      )}
      {who && (lots.length ? (
        <div className="grid gap-1">
          {lots.map((l, k) => <div key={k} className="flex items-baseline justify-between gap-2 rounded-lg bg-muted/70 px-2.5 py-1.5 text-[13px]"><span className="font-mono">{fmtTokens(l.amount)} ${s}</span><span className="text-[12.5px] text-muted-foreground">locked <Ago ns={l.since} /></span></div>)}
        </div>
      ) : null)}
    </div>
  );
}

// Where the curve would sit after the trade typed into the ticket (same math as the contract).
function previewNear(i, q) {
  if (!q) return null;
  const N = BigInt(i.amm_near), T = BigInt(i.amm_tokens), fee = BigInt(state.params.trade_fee_bps);
  if (q.mode === "buy") return N + q.eff - (q.eff * fee) / 10000n;
  if (q.mode === "sell") return N - (N * q.amount) / (T + q.amount);
  return null;
}

export default function Market() {
  const [quote, setQuote] = useState(null);
  const a = state.sel, i = state.info[a];
  return (
    <>
      <Guide />
      <Ticker />
      <section id="market" className="border-b border-dashed border-line pb-2 pt-6">
        <SectionHead title="Market" />
        <MarketTable />
      </section>
      {i && (
        <section id="trade" className="pt-6">
          <SectionHead title="Coin & trade" note="pick a coin in the market above" />
          <div className="grid border-t border-dashed border-line lg:grid-cols-[minmax(0,1fr)_360px] xl:grid-cols-[minmax(0,1fr)_380px]">
            <CoinPanel a={a} afterNear={quote && quote.coin === a ? previewNear(i, quote) : null} />
            <aside id="ticket" className="min-w-0 border-dashed border-line px-6 pb-7 pt-5 max-lg:border-t max-sm:px-4 lg:border-l"><Ticket a={a} onQuote={setQuote} /></aside>
          </div>
        </section>
      )}
    </>
  );
}
