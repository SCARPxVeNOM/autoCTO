// Market view: first steps, totals, the coin table, and the selected coin with its trade ticket.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { BadgeCheck, Brain, Check, CircleAlert, Eye, LoaderCircle, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { Ago, Avatar, Left, More, Pill, SectionHead, Term, useTick } from "@/components/common";
import {
  NETWORK, act, allOffers, available, cfg, coinStatus, curveReal, fetchQuote, fmtNear, fmtPct, fmtPrice, fmtRate, fmtTokens, fmtUnits,
  guideSteps, hasWallet, isMerged, liveOffer, lockedOf, marketCap, minOut, modeDec, nearNum, now, parseUnits, priceNum, sameCode,
  selectCoin, sessionChange, short, state, statusName, store, sym, tokNum,
} from "@/lib/chain";
import { curveChart, sessionChart, sparkline } from "./charts";
import { useUi } from "./ui";

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
        <Button variant="ghost" size="sm" className="ml-auto" onClick={toggle}>{hidden ? "All steps" : "Hide"}</Button>
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
                  <Avatar symbol={i.symbol} icon={i.icon} />
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
          <Avatar symbol={i.symbol} icon={i.icon} size={52} />
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
      <BrainBox a={a} />
    </div>
  );
}

// ---------- the coin's brain ----------
const NS = 1_000_000_000n;
// NEAR keeps a brain request open for about 2 minutes; an answer after that is refused.
const ANSWER_SEC = 120;
const clock = (sec) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;

/** OutLayer's recent record from the site's api/outlayer, or null when unknown (local demo, no function). */
function useOutlayer() {
  const [h, setH] = useState(null);
  useEffect(() => {
    if (NETWORK === "local") return;
    let live = true;
    const get = () => fetch(`api/outlayer?network=${NETWORK}`).then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (live) setH(j?.runs > 0 ? j : null); }).catch(() => {});
    get();
    const t = setInterval(get, 60_000);
    return () => { live = false; clearInterval(t); };
  }, []);
  return h;
}

function OutlayerLine({ h }) {
  if (!h) return null;
  const share = h.answered / h.runs;
  return (
    <p className={share >= 0.9 ? "text-up" : share >= 0.6 ? "text-warn" : "text-down"}>
      OutLayer {h.network} right now: {h.answered} of {h.runs} runs answered in the last {h.minutes} minutes{h.late ? `; ${h.late} came back too late` : ""}.
    </p>
  );
}

const Choice = ({ title, btn, children, ...rest }) => (
  <div className="grid gap-1.5 rounded-xl border border-line bg-background/60 p-3">
    <b className="text-[13.5px] font-semibold text-foreground">{title}</b>
    <p>{children}</p>
    <Button size="sm" className="justify-self-start rounded-full" {...rest}>{btn}</Button>
  </div>
);

// Think, what the brain is doing now, and when it missed: wait and try again, or bid by hand.
function BrainBox({ a }) {
  useTick();
  const [hand, setHand] = useState(false);
  const health = useOutlayer();
  const i = state.info[a], s = i.symbol, p = state.params, t = now();
  const last = (state.decisions[a] || []).reduce((m, d) => (m && BigInt(m.requested_at) > BigInt(d.requested_at) ? m : d), null);
  const st = last && statusName(last.status);
  const age = last ? Number((t - BigInt(last.requested_at)) / NS) : 0;
  const thinking = st === "Pending";
  // A miss from the last half hour gets the choice; older ones stay under Brains.
  const missed = st === "NoAnswer" && age < 1800;
  const ready = BigInt(i.last_think || 0) + BigInt(p.think_cooldown_sec) * NS;
  const rest = i.last_think && ready > t ? Number((ready - t) / NS) + 1 : 0;
  const busy = health && health.answered / health.runs < 0.9;
  const fee = fmtNear(p.brain_fee);
  const need = (BigInt(i.circulating) * BigInt(p.proposer_bps)) / 10_000n;
  const think = () => act("think", { coin: a });
  const byHand = () => { setHand(true); setTimeout(() => document.getElementById("handbid")?.scrollIntoView({ behavior: "smooth", block: "nearest" }), 50); };
  return (
    <>
      <div className="flex items-center gap-2.5 border-t border-dashed border-line pt-3.5">
        <Button id="think" variant="outline" className="flex-none rounded-full" disabled={state.acting || thinking || rest > 0} onClick={think}>
          {thinking ? <LoaderCircle className="animate-spin" /> : <Brain />} {rest > 0 && !thinking ? `Think · ${rest}s` : "Think"}
        </Button>
        <span className="text-[12.5px] text-muted-foreground" title={`Used ${fmtNear(i.brain_spent_today)} of ${fmtNear(p.brain_daily_cap)} today`}>Wake ${s}'s AI to look for a deal · {fee} · up to 2 min</span>
      </div>
      {thinking && (
        <div className="grid gap-2 rounded-2xl border border-primary/35 bg-primary/[0.06] p-3.5 text-[12.5px] text-muted-foreground">
          <b className="font-display text-sm font-semibold text-foreground">${s}'s brain is thinking · {clock(age)} of up to {clock(ANSWER_SEC)}</b>
          <Progress value={Math.min(100, (age / ANSWER_SEC) * 100)} className="h-1.5" />
          <p>It runs on OutLayer, in sealed hardware. NEAR waits about 2 minutes for the answer. If none arrives, the request closes and the fee comes back, minus anything OutLayer used.</p>
          <OutlayerLine h={health} />
        </div>
      )}
      {missed && (
        <div className="grid gap-2.5 rounded-2xl border border-down/40 bg-down/[0.06] p-3.5 text-[12.5px] text-muted-foreground">
          <b className="flex items-center gap-1.5 font-display text-sm font-semibold text-foreground"><CircleAlert className="size-4 flex-none text-down" />${s}'s brain didn't answer · decision #{last.id}</b>
          <p>No answer reached the chain within its 2 minutes, usually because OutLayer was busy. The fee came back, minus anything OutLayer used. Nothing else changed.</p>
          <OutlayerLine h={health} />
          <b className="text-[13.5px] font-semibold text-foreground">Your choice</b>
          <Choice title="Wait and try again" btn={rest > 0 ? `Ready in ${rest}s` : "Think again"} disabled={state.acting || rest > 0} onClick={think}>
            Ask the AI again for {fee}. If it misses again, the fee comes back the same way. Best when OutLayer answers most runs.
          </Choice>
          <Choice title="Bid by hand" btn="Bid by hand" variant="outline" onClick={byHand}>
            Make the bid yourself, under the same caps the AI works with, and the holders vote on it the same way. Needs {fmtTokens(need)} ${s} locked by you ({p.proposer_bps / 100}% of supply); you have {fmtTokens(lockedOf(a))}.
          </Choice>
        </div>
      )}
      {!thinking && !missed && busy && (
        <div className="grid gap-1 text-[12.5px]">
          <OutlayerLine h={health} />
          <p className="text-muted-foreground">Think may miss right now; the fee comes back if it does. Bid by hand works either way.</p>
        </div>
      )}
      <HandBid a={a} open={hand} setOpen={setHand} link={!missed} />
    </>
  );
}

// When the brain doesn't answer, a holder can make the same bid by hand: same caps,
// and it needs proposer_bps of the supply locked in an earlier block.
const PREMIUMS = [["0", "fair rate"], ["300", "+3%"], ["500", "+5%"], ["1000", "+10%"]];
// When $t last turned down a bid from $b, after which it refuses b's bids for rebid_cooldown_sec.
// From t's feed; failing that, the end of the vote (the earliest the bid can have failed).
function lastRefusal(t, b) {
  const at = (state.history[t] || []).filter((e) => e.event === "offer_failed" && e.text.startsWith(`bid ${b}#`)).map((e) => BigInt(e.at));
  if (!at.length) for (const o of state.offers[t] || []) if (o.target === t && o.buyer === b && statusName(o.status) === "Failed") at.push(BigInt(o.vote_ends));
  return at.reduce((m, x) => (x > m ? x : m), 0n);
}
function HandBid({ a, open, setOpen, link }) {
  const [target, setTarget] = useState("");
  const [prem, setPrem] = useState("300");
  const [pitch, setPitch] = useState("");
  const i = state.info[a], s = i.symbol, p = state.params;
  const targets = state.coins.map((c) => c.account_id).filter((t) => t !== a && state.info[t] && statusName(state.info[t].status) === "Active");
  if (!targets.length) return null;
  if (!open) return link && <button type="button" className="justify-self-start text-[12.5px] text-primary underline underline-offset-2" onClick={() => setOpen(true)}>Brain not answering? Bid by hand</button>;
  const t = targets.includes(target) ? target : targets[0], ti = state.info[t], T = sym(t);
  const den = BigInt(ti.amm_tokens) * BigInt(i.amm_near);
  const fair = den > 0n ? (BigInt(ti.amm_near) * BigInt(i.amm_tokens) * 1_000_000n) / den : 0n;
  const rateAt = (bps) => (fair * (10_000n + BigInt(bps))) / 10_000n;
  // The target runs the same checks when the bid arrives and refuses it outright if one fails.
  // Dilution: the deal may mint at most max_dilution_bps of the buyer's supply. Half a percent
  // of headroom, since the target counts its supply again when the bid lands.
  const supply = (x) => BigInt(x.circulating) + BigInt(x.owed || 0);
  const capRate = supply(ti) > 0n ? (supply(i) * BigInt(p.max_dilution_bps) * 1_000_000n * 995n) / (10_000n * supply(ti) * 1000n) : 0n;
  const capBps = fair > 0n ? Number((capRate * 10_000n) / fair) - 10_000 : -Infinity;
  const fits = (bps) => Number(bps) <= p.max_premium_bps && Number(bps) >= -p.max_discount_bps && rateAt(bps) <= capRate;
  const opts = [...PREMIUMS];
  // Where the cap falls between the usual choices, offer the most it allows.
  if (capBps >= -p.max_discount_bps && capBps < Number(PREMIUMS.at(-1)[0]) && !PREMIUMS.some(([v]) => Number(v) === capBps)) {
    opts.push([String(capBps), `${capBps >= 0 ? "+" : ""}${(capBps / 100).toFixed(1)}% (the most allowed)`]);
    opts.sort((x, y) => Number(x[0]) - Number(y[0]));
  }
  const choice = fits(prem) ? prem : [...opts].reverse().find(([v]) => fits(v) && Number(v) <= Number(prem))?.[0] ?? opts.find(([v]) => fits(v))?.[0] ?? null;
  const rate = choice == null ? 0n : rateAt(choice);
  const need = (BigInt(i.circulating) * BigInt(p.proposer_bps)) / 10_000n;
  const have = lockedOf(a), lacking = !!state.me.acct && have < need;
  const pending = allOffers().some((o) => ((o.buyer === a && o.target === t) || (o.buyer === t && o.target === a)) && liveOffer(o));
  const newborn = BigInt(ti.protected_until) > now() ? BigInt(ti.protected_until) : 0n;
  const coolUntil = (() => {
    const at = lastRefusal(t, a);
    const until = at && at + BigInt(p.rebid_cooldown_sec) * NS;
    return until > now() ? until : 0n;
  })();
  const blocked = pending || newborn > 0n || coolUntil > 0n || choice == null || fair === 0n;
  const said = pitch.trim() || `$${s} bids for $${T} at ${opts.find(([v]) => v === choice)?.[1] ?? "the fair rate"}.`;
  const send = async () => { if (await act("propose", { coin: a, target: t, rate: rate.toString(), pitch: said })) setOpen(false); };
  return (
    <div id="handbid" className="grid gap-2.5 rounded-2xl border border-dashed border-line p-3.5 text-[12.5px] text-muted-foreground">
      <div className="flex items-center justify-between gap-2">
        <b className="font-display text-sm font-semibold text-foreground">Bid by hand</b>
        <Button variant="ghost" size="sm" className="h-7" onClick={() => setOpen(false)}>Close</Button>
      </div>
      <p>The same bid ${s}'s brain could make, under the same caps. ${T}'s holders vote on it.</p>
      <div className="flex flex-wrap gap-2">
        <Select value={t} onValueChange={setTarget}>
          <SelectTrigger size="sm" className="h-8 rounded-full"><SelectValue /></SelectTrigger>
          <SelectContent>{targets.map((x) => <SelectItem key={x} value={x}>Bid for ${sym(x)}</SelectItem>)}</SelectContent>
        </Select>
        {choice != null && <Select value={choice} onValueChange={setPrem}>
          <SelectTrigger size="sm" className="h-8 rounded-full"><SelectValue /></SelectTrigger>
          <SelectContent>{opts.map(([v, label]) => <SelectItem key={v} value={v} disabled={!fits(v)}>{label}{fits(v) ? "" : " · over the cap"}</SelectItem>)}</SelectContent>
        </Select>}
      </div>
      {choice != null && <div>Rate <b className="font-mono font-medium text-foreground">{fmtRate(rate)}</b> ${s} per ${T} · fair {fmtRate(fair)}</div>}
      {choice == null && fair > 0n
        ? <p className="text-down">${T} is too big for ${s} right now. Even at the lowest rate allowed ({-p.max_discount_bps / 100}%), the deal would mint more ${s} than its cap of {p.max_dilution_bps / 100}% of ${s}'s supply, so ${T} would refuse it.</p>
        : opts.some(([v]) => !fits(v)) && <p>A bid above {capBps >= 0 ? "+" : ""}{(capBps / 100).toFixed(1)}% would mint more ${s} than its cap allows ({p.max_dilution_bps / 100}% of ${s}'s supply), so ${T} would refuse it.</p>}
      <input value={pitch} onChange={(e) => setPitch(e.target.value)} maxLength={500} placeholder={said} autoComplete="off"
        className="rounded-full border border-line bg-muted/60 px-3.5 py-1.5 text-[13.5px] text-foreground outline-none placeholder:text-muted-foreground/70 focus:border-ring" />
      <p className={cn(lacking && "text-down")}>Needs {fmtTokens(need)} ${s} locked by you first ({p.proposer_bps / 100}% of supply); you have {fmtTokens(have)}. Bidding holds them for {Math.round(p.vote_period_sec / 60)} min, even if ${T} refuses the bid.</p>
      {pending && <p className="text-down">There is already an open bid between ${s} and ${T}. It is under Deals; one at a time.</p>}
      {newborn > 0n && <p className="text-down">${T} is newborn: no bids until its protection ends (<Left ns={newborn} />).</p>}
      {coolUntil > 0n && <p className="text-down">${T} turned down a bid from ${s} recently, so it refuses ${s}'s bids for a while (<Left ns={coolUntil} />).</p>}
      <Button size="sm" className="justify-self-start rounded-full" disabled={state.acting || lacking || blocked} onClick={send}>Bid for ${T}</Button>
    </div>
  );
}

function Position({ a }) {
  const s = state.info[a].symbol, who = state.me.acct;
  const until = state.me.until[a] || 0n, lots = state.me.locks[a] || [];
  return (
    <div className="grid gap-2 border-t border-dashed border-line pt-3.5">
      <h4 className="text-[15px] font-semibold">Your position</h4>
      {!who ? (
        <p className="text-[13.5px] text-muted-foreground">{cfg.dev_key ? "No account selected." : hasWallet() ? (state.guestOffer ? "Connect a wallet, or try as a guest, to see your balances." : "Connect a wallet to see your balances.") : "Type your account at the top."}</p>
      ) : (
        <dl className="grid gap-1.5 text-[13.5px]">
          <Row k={`$${s} you can sell`}>{fmtTokens(state.me.bal[a] || 0n)}</Row>
          <Row k={<>${s} <Term k="lock">locked for votes</Term></>}>{fmtTokens(lockedOf(a))}</Row>
          <Row k="NEAR">{state.me.near == null ? "–" : fmtNear(state.me.near)}</Row>
          {until > now() && <Row k={<>locked ${s} <Term k="held">held</Term></>}><Left ns={until} /></Row>}
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
