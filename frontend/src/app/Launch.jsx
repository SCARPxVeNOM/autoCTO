// Launch view: fill in a coin on the left, watch it take shape on the right, launch.
import { useRef, useState } from "react";
import { Brain, ImagePlus, Lock, Rocket, ScrollText, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { Avatar, PageHead } from "@/components/common";
import { YOCTO, act, cfg, fmtNear, hasWallet, short, state } from "@/lib/chain";

const PERSONAS = [
  ["Hungry hunter", "A hungry hunter that bids for any smaller coin with a fat treasury."],
  ["Careful builder", "A careful builder that only merges when both sides clearly win."],
  ["Chaotic gambler", "A chaotic gambler that loves bold bids and louder pitches."],
  ["Loyal guardian", "A loyal guardian that defends its holders and counters every low offer."],
];
// The launchpad allows a 40 character name and a 12 character ticker. 280 keeps a personality to a pitch.
const MAX = { name: 40, symbol: 12, persona: 280 };
const EMPTY = { name: "", symbol: "", label: "", persona: "", icon: null };
const toLabel = (v) => v.toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 32);
const FIXED = [
  [Lock, "Nobody holds its keys, so nobody can change it or take its funds. Not even you."],
  [ScrollText, "Same code and rules as every other coin here."],
  [Brain, "Its brain only proposes. Holders vote and the contract checks every number."],
];

// The contract keeps an icon of at most 4096 characters, so the picked image is cropped square,
// shrunk and compressed until its data URL fits.
async function iconFrom(file) {
  const img = await createImageBitmap(file);
  const side = Math.min(img.width, img.height);
  const c = document.createElement("canvas");
  for (const px of [64, 48, 40]) {
    c.width = c.height = px;
    for (const type of ["image/webp", "image/jpeg"]) {
      const g = c.getContext("2d");
      g.clearRect(0, 0, px, px);
      // JPEG has no transparency, so it gets a white backing.
      if (type === "image/jpeg") { g.fillStyle = "#fff"; g.fillRect(0, 0, px, px); }
      g.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, px, px);
      for (const q of [0.85, 0.7, 0.55, 0.4]) {
        const url = c.toDataURL(type, q);
        if (url.startsWith(`data:${type}`) && url.length <= 4096) return url;
      }
    }
  }
  throw new Error("That image is too detailed to store with the coin. Try a simpler one.");
}

const Step = ({ n, title, hint, children }) => (
  <section className="grid gap-5 border-b border-dashed border-line px-6 py-6 max-sm:px-4">
    <div className="flex items-start gap-3">
      <span className="grid size-7 flex-none place-items-center rounded-full border-[1.5px] border-dashed border-primary font-mono text-[13px] font-semibold text-primary">{n}</span>
      <div className="grid gap-0.5"><h2 className="text-[17px] font-semibold leading-7">{title}</h2>{hint && <p className="text-[13.5px] text-muted-foreground">{hint}</p>}</div>
    </div>
    <div className="grid gap-4 sm:pl-10">{children}</div>
  </section>
);

function Field({ id, label, hint, error, count, max, children }) {
  return (
    <div className="grid content-start gap-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <Label htmlFor={id}>{label}</Label>
        {max && <span className="font-mono text-[11.5px] text-muted-foreground">{count}/{max}</span>}
      </div>
      {children}
      {(error || hint) && <p id={`${id}-note`} className={cn("text-[12.5px]", error ? "text-down" : "text-muted-foreground")}>{error || hint}</p>}
    </div>
  );
}

export default function Launch() {
  const [f, setF] = useState(EMPTY);
  const [seen, setSeen] = useState({});
  const [ownLabel, setOwnLabel] = useState(false);
  const [iconErr, setIconErr] = useState("");
  const pickFile = useRef(null);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v, ...(k === "name" && !ownLabel ? { label: toLabel(v) } : {}) }));
  const leave = (k) => () => setSeen((s) => ({ ...s, [k]: true }));

  const taken = state.coins.some((c) => c.account_id === `${f.label}.${cfg.launchpad}`);
  const errors = {
    name: !f.name.trim() && "Give your coin a name.",
    symbol: !/^[A-Z0-9]{1,12}$/.test(f.symbol) && "Up to 12 letters or digits.",
    label: !/^[a-z0-9_-]{2,32}$/.test(f.label) ? "2 to 32 characters: a-z, 0-9, - and _." : taken && "A coin already lives at this address. Pick another.",
    persona: !f.persona.trim() && "Pick a personality or write one.",
  };
  const err = (k) => seen[k] && errors[k];
  const ready = !Object.values(errors).some(Boolean);

  const pick = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setIconErr("");
    try { set("icon", await iconFrom(file)); } catch (x) { setIconErr(x.message || "Could not read that image."); }
  };
  const submit = async (e) => {
    e.preventDefault();
    if (!ready) {
      setSeen({ name: true, symbol: true, label: true, persona: true });
      document.getElementById(`l-${Object.keys(errors).find((k) => errors[k])}`)?.focus();
      return;
    }
    if (await act("launch", { form: f })) { setF(EMPTY); setSeen({}); setOwnLabel(false); }
  };
  const who = cfg.dev_key ? `Launching as ${short(state.actor)}, with play money.`
    : state.wallet ? `Launching from ${state.wallet}.`
    : hasWallet() ? "You'll be asked to connect a wallet." : "You'll get a command to sign with your own account.";
  const deposit = state.launchMin != null ? fmtNear(state.launchMin + YOCTO) : "–";

  return (
    <>
      <PageHead icon={Rocket} title="Launch a coin" lede="Create a memecoin with its own AI brain. It trades on its own price curve from the first second, and it can bid for other coins or be bid for." />
      <form onSubmit={submit} autoComplete="off" noValidate className="grid lg:grid-cols-[minmax(0,1fr)_360px] xl:grid-cols-[minmax(0,1fr)_400px]">
        <div className="min-w-0">
          <Step n={1} title="Name it" hint="How your coin shows up in the market.">
            <div className="grid gap-4 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
              <Field id="l-name" label="Name" error={err("name")} count={f.name.length} max={MAX.name}>
                <Input id="l-name" maxLength={MAX.name} placeholder="Bonk" value={f.name} aria-invalid={!!err("name")} onChange={(e) => set("name", e.target.value)} onBlur={leave("name")} />
              </Field>
              <Field id="l-symbol" label="Ticker" error={err("symbol")} hint="Shown as $TICKER." count={f.symbol.length} max={MAX.symbol}>
                <Input id="l-symbol" maxLength={MAX.symbol} placeholder="BONK" className="font-mono uppercase" value={f.symbol} aria-invalid={!!err("symbol")}
                  onChange={(e) => set("symbol", e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))} onBlur={leave("symbol")} />
              </Field>
            </div>
            <Field id="l-label" label="Address" error={err("label")} hint="Follows the name until you change it. It can't be changed after launch.">
              <div className={cn("flex h-9 min-w-0 items-center rounded-md border border-input shadow-xs transition-[color,box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50 dark:bg-input/30", err("label") && "border-destructive")}>
                <input id="l-label" className="h-full min-w-0 flex-1 bg-transparent px-3 font-mono text-sm outline-none placeholder:text-muted-foreground" placeholder="bonk" spellCheck={false}
                  value={f.label} aria-invalid={!!err("label")} onChange={(e) => { setOwnLabel(true); set("label", toLabel(e.target.value)); }} onBlur={leave("label")} />
                <span className="max-w-[55%] truncate pr-3 font-mono text-[12.5px] text-muted-foreground">.{cfg.launchpad}</span>
              </div>
            </Field>
            <Field id="l-icon" label="Icon (optional)" error={iconErr} hint="A square picture works best. It is shrunk to 64 px and stored with the coin on chain.">
              <div className="flex flex-wrap items-center gap-3">
                <Avatar symbol={f.symbol || "?"} icon={f.icon} size={44} />
                <input ref={pickFile} id="l-icon" type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="sr-only" onChange={pick} />
                <Button type="button" variant="outline" size="sm" className="rounded-full" onClick={() => pickFile.current.click()}><ImagePlus /> {f.icon ? "Change picture" : "Choose a picture"}</Button>
                {f.icon && <Button type="button" variant="ghost" size="sm" className="rounded-full" onClick={() => set("icon", null)}><X /> Remove</Button>}
              </div>
            </Field>
          </Step>

          <Step n={2} title="Give its brain a personality" hint="The brain reads this before every move. It shapes who it bids for and how it talks to holders.">
            <div className="grid gap-2 sm:grid-cols-2" role="group" aria-label="Personality ideas">
              {PERSONAS.map(([title, text]) => (
                <button key={title} type="button" aria-pressed={f.persona === text} onClick={() => { set("persona", text); setSeen((s) => ({ ...s, persona: true })); }}
                  className={cn("grid gap-0.5 rounded-xl border px-3.5 py-2.5 text-left transition-colors hover:bg-muted/70", f.persona === text && "border-primary bg-primary/[0.07] hover:bg-primary/[0.1]")}>
                  <b className="text-[14px] font-semibold">{title}</b><span className="text-[12.5px] text-muted-foreground">{text}</span>
                </button>
              ))}
            </div>
            <Field id="l-persona" label="Or write your own" error={err("persona")} count={f.persona.length} max={MAX.persona}>
              <textarea id="l-persona" rows={3} maxLength={MAX.persona} placeholder="A loud dog that only buys coins with big treasuries." value={f.persona} aria-invalid={!!err("persona")}
                onChange={(e) => set("persona", e.target.value)} onBlur={leave("persona")}
                className="min-h-[84px] w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-base shadow-xs outline-none transition-[color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive md:text-sm dark:bg-input/30" />
            </Field>
          </Step>
        </div>

        <aside className="min-w-0 border-dashed border-line px-6 py-6 max-lg:border-t max-sm:px-4 lg:border-l" aria-label="Review and launch">
          <div className="grid gap-4 lg:sticky lg:top-[84px]">
            <div className="flex items-center gap-3">
              <span className="grid size-7 flex-none place-items-center rounded-full border-[1.5px] border-dashed border-primary font-mono text-[13px] font-semibold text-primary">3</span>
              <h2 className="text-[17px] font-semibold">Review and launch</h2>
            </div>
            <Card className="gap-3 rounded-2xl p-4 shadow-none">
              <div className="flex min-w-0 items-center gap-3">
                <Avatar symbol={f.symbol || "?"} icon={f.icon} size={52} />
                <div className="min-w-0">
                  <b className="block truncate font-display text-lg font-semibold">{f.symbol ? `$${f.symbol}` : "$TICKER"} <span className="font-sans text-[15px] font-normal text-muted-foreground">{f.name || "Your coin"}</span></b>
                  <span className="block break-all font-mono text-[12px] text-muted-foreground">{f.label || "address"}.{cfg.launchpad}</span>
                </div>
              </div>
              <p className={cn("text-[13.5px]", f.persona ? "text-foreground" : "text-muted-foreground")}>“{f.persona || "How its brain talks and what it goes after."}”</p>
            </Card>
            <div className="grid gap-1.5 rounded-2xl border border-dashed border-line px-4 py-3">
              <div className="flex items-baseline justify-between gap-3"><span className="text-muted-foreground">Deposit</span><b className="font-mono text-base font-medium">{deposit}</b></div>
              <p className="text-[12.5px] text-muted-foreground">Pays for the coin's storage on chain, a small reserve and 1 Ⓝ of thinking budget for its brain.</p>
            </div>
            <ul className="grid gap-2 text-[13.5px]">
              {FIXED.map(([Icon, text]) => <li key={text} className="flex items-start gap-2.5"><Icon className="mt-0.5 size-4 flex-none text-up" />{text}</li>)}
            </ul>
            <Button type="submit" size="lg" className="btn-big h-[46px] w-full text-base font-semibold" disabled={state.acting}><Rocket /> Launch {f.symbol ? `$${f.symbol}` : "coin"}</Button>
            <p className="text-center text-[12.5px] text-muted-foreground">{ready ? who : "Fill in steps 1 and 2 to launch."}</p>
          </div>
        </aside>
      </form>
    </>
  );
}
