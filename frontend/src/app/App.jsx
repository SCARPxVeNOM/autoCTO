// The app's shell: sidebar, top bar, one view at a time (picked by the address hash) and the dialogs.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, BookOpen, Brain, CircleHelp, Copy, LayoutDashboard, ListChecks, Moon, Rocket, Scale, ShieldCheck, Sun, SunMoon, Swords, Wallet } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useTheme } from "@/lib/theme";
import { Logo, Pill, Term, Wordmark } from "@/components/common";
import {
  GLOSSARY, NETWORK, allOffers, cfg, closeDialog, connectWallet, guideSteps, hasWallet, isMerged, liveOffer,
  selectCoin, setActor, setGasless, short, start, state, statusName, useChain,
} from "@/lib/chain";
import { UiContext } from "./ui";
import Market from "./Market";
import Deals from "./Deals";
import Brains from "./Brains";
import Launch from "./Launch";
import Rules from "./Rules";
import Verify from "./Verify";
import { AutoPanel } from "./Autoplay";

// Which view each address hash belongs to.
const VIEW_OF = { market: "market", guide: "market", trade: "market", deals: "deals", brains: "brains", feed: "brains", launch: "launch", rules: "rules", sim: "rules", verify: "verify" };
const VIEWS = { market: Market, deals: Deals, brains: Brains, launch: Launch, rules: Rules, verify: Verify };
const hashId = () => location.hash.slice(1);
// "What is AutoCTO" keeps the network the visitor is on.
const HOME = `index.html${location.search}`;
const THEME_ICON = { auto: SunMoon, dark: Moon, light: Sun };

function NavLink({ href, icon: Icon, on, count, soft, children, ...props }) {
  return (
    <a href={href} aria-current={on ? "page" : undefined} {...props}
      className={cn("flex h-9 items-center gap-2.5 rounded-[10px] px-2.5 text-[14.5px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground", on && "bg-muted font-medium text-foreground")}>
      <Icon className={cn("size-[17px] flex-none", on && "text-primary")} />{children}
      {count > 0 && <b className={cn("ml-auto rounded-full px-1.5 font-mono text-[11px] font-semibold leading-[18px]", soft ? "bg-muted text-muted-foreground" : "bg-primary text-primary-foreground")}>{count}</b>}
    </a>
  );
}
const NavGroup = ({ children }) => <h2 className="mt-4 px-2.5 pb-1 font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground first:mt-0">{children}</h2>;

function Dialogs({ glossary, setGlossary }) {
  const d = state.dialog;
  const copy = (text) => navigator.clipboard?.writeText(text).then(() => toast.success("Copied."), () => toast.error("Could not copy. Select the text and copy it by hand."));
  return (
    <>
      <Dialog open={glossary} onOpenChange={setGlossary}>
        <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-[640px]">
          <DialogHeader><DialogTitle>Words explained</DialogTitle><DialogDescription>Every dotted word on the page explains itself when you point at it.</DialogDescription></DialogHeader>
          <dl className="grid gap-3">
            {Object.entries(GLOSSARY).map(([k, v]) => <div key={k}><dt className="font-display font-semibold capitalize">{k}</dt><dd className="text-sm text-muted-foreground">{v}</dd></div>)}
          </dl>
        </DialogContent>
      </Dialog>
      <Dialog open={!!d} onOpenChange={(o) => !o && closeDialog()}>
        {d?.type === "cli" && (
          <DialogContent className="sm:max-w-[680px]">
            <DialogHeader><DialogTitle>{d.title}</DialogTitle>
              <DialogDescription>This page cannot sign for you on this network. Run the command below with near-cli-rs, signed by your own account.</DialogDescription></DialogHeader>
            <pre className="max-h-[260px] overflow-auto whitespace-pre-wrap break-all rounded-xl border bg-muted/60 px-3 py-2.5 font-mono text-xs leading-normal">{d.command}</pre>
            {d.sealed && <p className="text-[13px] text-muted-foreground">Your sealed vote's secret is kept in this browser. Come back here to reveal it when the vote ends.</p>}
            <Button variant="outline" className="justify-self-start rounded-full" onClick={() => copy(d.command)}><Copy /> Copy command</Button>
          </DialogContent>
        )}
        {d?.type === "salt" && (
          <DialogContent className="sm:max-w-[560px]">
            <DialogHeader><DialogTitle>Save this to reveal your vote</DialogTitle>
              <DialogDescription>Your browser would not store the secret for your sealed {d.support ? "YES" : "NO"} vote. Keep it: without it the vote cannot be revealed and will not count.</DialogDescription></DialogHeader>
            <pre className="overflow-auto whitespace-pre-wrap break-all rounded-xl border bg-muted/60 px-3 py-2.5 font-mono text-xs leading-normal">offer {d.offer}{"\n"}vote {d.support ? "yes" : "no"}{"\n"}salt {d.salt}</pre>
            <Button variant="outline" className="justify-self-start rounded-full" onClick={() => copy(d.salt)}><Copy /> Copy salt</Button>
          </DialogContent>
        )}
      </Dialog>
    </>
  );
}

// Who the page acts as: a demo holder, a connected wallet, or just an account to look at.
function Who() {
  const dev = !!cfg.dev_key, wallet = hasWallet();
  const [typed, setTyped] = useState(state.actor);
  useEffect(() => { setTyped(state.actor); }, [state.actor]);
  if (!state.ready && !cfg.launchpad) return null;
  return (
    <>
      {dev && (
        <label className="flex items-center gap-2" title="A local demo with play money: switch between the demo holders to see every side of a deal">
          <span className="text-[12.5px] text-muted-foreground max-sm:hidden">playing as</span>
          <Select value={state.actor} onValueChange={setActor}>
            <SelectTrigger id="actor" size="sm" className="min-w-[104px] rounded-full font-mono text-[13px]"><SelectValue /></SelectTrigger>
            <SelectContent>{(cfg.accounts || []).map((a) => <SelectItem key={a} value={a} className="font-mono text-[13px]">{short(a)}</SelectItem>)}</SelectContent>
          </Select>
        </label>
      )}
      {!dev && (!wallet || state.wallet) && (
        <label className="flex items-center gap-2">
          <span className="text-[12.5px] text-muted-foreground max-sm:hidden">account</span>
          <Input id="viewer" className="h-8 w-[168px] rounded-full font-mono text-[13px] max-sm:w-[128px]" placeholder={`you.${NETWORK === "local" ? "testnet" : NETWORK}`} autoComplete="off" spellCheck={false}
            readOnly={!!state.wallet} value={typed} onChange={(e) => setTyped(e.target.value.trim())}
            onBlur={() => typed !== state.actor && setActor(typed)} onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()} />
        </label>
      )}
      {!dev && wallet && <Button id="connect" size="sm" variant={state.wallet ? "outline" : "default"} className="rounded-full" onClick={connectWallet}><Wallet /> {state.wallet ? "Disconnect" : "Connect wallet"}</Button>}
      {dev && cfg.relayer && (
        <label className="flex items-center gap-1.5 text-[13px] text-muted-foreground max-sm:hidden">
          <Checkbox checked={state.gasless} onCheckedChange={(v) => setGasless(v === true)} /> <Term k="gasless" />
        </label>
      )}
    </>
  );
}

export default function App() {
  useChain();
  const [theme, cycleTheme] = useTheme();
  const [id, setId] = useState(hashId);
  const [mode, setMode] = useState("buy");
  const [glossary, setGlossary] = useState(false);
  const amtRef = useRef(null);
  const view = VIEW_OF[id] || "market";
  const View = VIEWS[view];

  useEffect(() => { start(); }, []);
  useEffect(() => {
    const on = () => setId(hashId());
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  // A new view starts at the top, unless the hash names a section further down.
  useEffect(() => {
    const el = ["trade", "feed", "sim"].includes(id) ? document.getElementById(id) : null;
    if (el) el.scrollIntoView({ block: "start" }); else scrollTo({ top: 0 });
  }, [id, view, state.ready]);

  const pointAt = useCallback((target, block = "center") => {
    // Wait a frame, so a view that was just switched to is on the page.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const el = typeof target === "string" ? document.getElementById(target) : target;
      if (!el) return;
      el.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block });
      el.classList.remove("ring-hint"); void el.offsetWidth; el.classList.add("ring-hint");
    }));
  }, []);
  // Jump to the place a first step is done, and point at it.
  const go = useCallback((where) => {
    const toMarket = () => { if (VIEW_OF[hashId()] && VIEW_OF[hashId()] !== "market") location.hash = "#trade"; };
    if (where === "who") {
      const el = document.getElementById(cfg.dev_key ? "actor" : state.wallet || !hasWallet() ? "viewer" : "connect");
      if (el) { pointAt(el); el.focus({ preventScroll: true }); }
    } else if (where === "buy" || where === "lock") {
      // Lock needs a coin this account holds; buy needs one that still trades.
      const ids = state.coins.map((c) => c.account_id).filter((a) => !isMerged(state.info[a]));
      const want = where === "lock" ? ids.find((a) => (state.me.bal[a] || 0n) > 0n) : ids.includes(state.sel) ? state.sel : ids[0];
      if (where === "lock" && !want) { toast("Buy a coin first: you can only lock tokens you hold."); return go("buy"); }
      toMarket();
      if (want) selectCoin(want);
      setMode(where);
      pointAt("ticket");
      setTimeout(() => amtRef.current?.focus({ preventScroll: true }), 80);
    } else if (where === "think") { toMarket(); pointAt("think"); }
    else if (where === "deals") location.hash = "#deals";
  }, [pointAt]);
  const ui = useMemo(() => ({ mode, setMode, amtRef, pointAt, go }), [mode, pointAt, go]);

  const deals = state.ready ? allOffers().filter(liveOffer).length + Object.values(state.tenders).flat().filter((t) => ["Open", "Opening"].includes(statusName(t.status))).length : 0;
  const todo = state.ready ? guideSteps().filter((s) => !s.done).length : 0;
  const ThemeIcon = THEME_ICON[theme];
  const links = [
    ["Trade"], ["#market", LayoutDashboard, "Market", "market"], ["#deals", Swords, "Deals", "deals", deals], ["#brains", Brain, "Brains & feed", "brains"],
    ["Build"], ["#launch", Rocket, "Launch a coin", "launch"], ["#rules", Scale, "Rules", "rules"], ["#verify", ShieldCheck, "Verify", "verify"],
  ];

  return (
    <UiContext.Provider value={ui}>
      <TooltipProvider delayDuration={120}>
        <div className="relative mx-auto grid min-h-dvh max-w-[1560px] border-line lg:grid-cols-[232px_minmax(0,1fr)] min-[1561px]:border-x">
          <aside className="sticky top-0 hidden h-dvh flex-col border-r border-line lg:flex">
            <a href={HOME} title="What is AutoCTO" className="flex h-[60px] flex-none items-center gap-2.5 border-b border-line px-5"><Logo /><Wordmark /></a>
            <nav aria-label="Sections" className="grid content-start gap-0.5 overflow-y-auto p-3">
              {links.map(([href, icon, label, v, count]) => (icon
                ? <NavLink key={href} href={href} icon={icon} on={view === v} count={count}>{label}</NavLink>
                : <NavGroup key={href}>{href}</NavGroup>))}
              <NavGroup>Help</NavGroup>
              <NavLink href="#guide" icon={ListChecks} count={todo} soft>First steps</NavLink>
              <NavLink href="#" icon={BookOpen} onClick={(e) => { e.preventDefault(); setGlossary(true); }}>Words explained</NavLink>
              <NavLink href={HOME} icon={ArrowLeft}>What is AutoCTO</NavLink>
            </nav>
          </aside>

          <div className="min-w-0">
            <header className="sticky top-0 z-30 flex h-[60px] items-center gap-x-3 border-b border-line bg-background/80 px-6 py-2 backdrop-blur-xl backdrop-saturate-150 max-sm:px-4">
              <a href={HOME} className="flex items-center gap-2.5 lg:hidden"><Logo /><span className="max-sm:hidden"><Wordmark /></span></a>
              <div className="ml-auto flex min-w-0 items-center justify-end gap-x-2.5 max-sm:gap-x-1.5">
                <Pill tone={state.online === false ? "down" : state.online ? "up" : "muted"} className="font-mono max-[420px]:hidden">
                  <i className={cn("size-1.5 rounded-full bg-current", state.online && "blink")} />{state.online === false ? `${NETWORK} · offline` : cfg.dev_key ? "local demo" : NETWORK}
                </Pill>
                <Who />
                <Button variant="ghost" size="icon" className="size-8 rounded-full max-sm:hidden" title="Words explained" aria-label="Words explained" onClick={() => setGlossary(true)}><CircleHelp /></Button>
                <Button variant="ghost" size="icon" className="size-8 rounded-full" title={`Theme: ${theme}`} aria-label="Switch theme" onClick={cycleTheme}><ThemeIcon /></Button>
              </div>
            </header>
            <nav aria-label="Sections" className="sticky top-[60px] z-20 flex gap-1 overflow-x-auto border-b border-line bg-background/90 px-3 py-2 backdrop-blur-xl lg:hidden">
              {links.filter(([, icon]) => icon).map(([href, Icon, label, v, count]) => (
                <a key={href} href={href} className={cn("inline-flex h-8 flex-none items-center gap-1.5 rounded-full px-3 text-[13.5px] text-muted-foreground", view === v && "bg-muted font-medium text-foreground")}>
                  <Icon className="size-4" />{label.split(" ")[0]}{count > 0 && <b className="rounded-full bg-primary px-1.5 font-mono text-[10.5px] leading-4 text-primary-foreground">{count}</b>}
                </a>
              ))}
            </nav>

            <main className="min-h-[70dvh]">
              {state.noConfig ? (
                <div className="grid max-w-[64ch] gap-3 px-6 py-16 max-sm:px-4">
                  <h2 className="text-[22px] font-semibold">Nothing is running on “{NETWORK}” yet</h2>
                  <p className="text-muted-foreground">This page reads <code className="font-mono text-foreground">config.{NETWORK}.json</code>, and there is none. Start the local demo with <code className="font-mono text-foreground">cargo run -p autocto-demo</code>, or open the page with <code className="font-mono text-foreground">?network=testnet</code>.</p>
                  <Button asChild variant="outline" className="justify-self-start rounded-full"><a href="app.html?network=testnet">Open the testnet</a></Button>
                </div>
              ) : !state.ready ? (
                <p className="px-6 py-16 text-muted-foreground max-sm:px-4">{state.online === false ? "The chain is not answering. If this is the local demo, it may have been stopped." : "Loading the market…"}</p>
              ) : <View />}
            </main>
            <footer className="border-t border-dashed border-line px-6 py-5 text-[12.5px] text-muted-foreground max-sm:px-4">AutoCTO · <a className="underline underline-offset-2" href="https://github.com/SCARPxVeNOM/autoCTO">Source</a></footer>
          </div>
        </div>
        <AutoPanel />
        <Dialogs glossary={glossary} setGlossary={setGlossary} />
        <Toaster position="bottom-center" />
      </TooltipProvider>
    </UiContext.Provider>
  );
}
