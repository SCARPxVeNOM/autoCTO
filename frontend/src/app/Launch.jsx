// Launch view: a coin takes shape as the form is filled in.
import { useState } from "react";
import { Rocket } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Avatar, SectionHead } from "@/components/common";
import { YOCTO, act, cfg, fmtNear, state } from "@/lib/chain";

const PERSONAS = [
  ["Hungry hunter", "A hungry hunter that bids for any smaller coin with a fat treasury."],
  ["Careful builder", "A careful builder that only merges when both sides clearly win."],
  ["Chaotic gambler", "A chaotic gambler that loves bold bids and louder pitches."],
  ["Loyal guardian", "A loyal guardian that defends its holders and counters every low offer."],
];
const EMPTY = { name: "", symbol: "", label: "", persona: "" };

export default function Launch() {
  const [f, setF] = useState(EMPTY);
  const [touched, setTouched] = useState(false);
  const set = (k, v) => setF((x) => {
    const n = { ...x, [k]: v };
    // Until the address is typed by hand, it follows the name.
    if (k === "name" && !touched) n.label = v.toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 32);
    return n;
  });
  const submit = async (e) => {
    e.preventDefault();
    if (await act("launch", { form: f })) { setF(EMPTY); setTouched(false); }
  };
  return (
    <section id="launch" className="pb-8 pt-6">
      <SectionHead title="Launch a coin" note="Your coin gets the same code and rules as every other. After launch nobody can change it, not even you." />
      <Card className="mx-6 max-w-[860px] gap-4 rounded-[20px] p-[18px] shadow-none max-sm:mx-4">
        <form onSubmit={submit} autoComplete="off" className="grid gap-4">
          <div className="flex items-center gap-3">
            <Avatar symbol={f.symbol || "?"} size={52} />
            <div className="min-w-0"><b className="font-display text-lg font-semibold">{f.symbol ? `$${f.symbol} ${f.name}` : f.name || "Your coin"}</b>
              <div className="break-all font-mono text-[12.5px] text-muted-foreground">{f.label || "name"}.{cfg.launchpad}</div></div>
          </div>
          <div className="grid gap-x-3 gap-y-3 sm:grid-cols-3">
            <div className="grid gap-1.5"><Label htmlFor="l-name">Name</Label><Input id="l-name" required maxLength={32} placeholder="Bonk" value={f.name} onChange={(e) => set("name", e.target.value)} /></div>
            <div className="grid gap-1.5"><Label htmlFor="l-sym">Ticker</Label><Input id="l-sym" required maxLength={10} placeholder="BONK" value={f.symbol} onChange={(e) => set("symbol", e.target.value.toUpperCase())} /></div>
            <div className="grid gap-1.5"><Label htmlFor="l-label">Address (lowercase, no spaces)</Label><Input id="l-label" required pattern="[a-z0-9_\-]{2,32}" placeholder="bonk" value={f.label} onChange={(e) => { setTouched(true); set("label", e.target.value); }} /></div>
            <div className="grid gap-1.5 sm:col-span-3"><Label htmlFor="l-persona">Personality: how its AI brain talks and what it goes after</Label><Input id="l-persona" required maxLength={280} placeholder="A loud dog that only buys coins with big treasuries." value={f.persona} onChange={(e) => set("persona", e.target.value)} /></div>
          </div>
          <div className="flex flex-wrap items-center gap-1.5" aria-label="Personality ideas">
            <span className="text-[12.5px] text-muted-foreground">Ideas:</span>
            {PERSONAS.map(([label, text]) => <Button key={label} type="button" variant="secondary" size="sm" className="h-7 rounded-full px-3 text-[13px]" onClick={() => set("persona", text)}>{label}</Button>)}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" className="rounded-full" disabled={state.acting}><Rocket /> Launch coin</Button>
            {state.launchMin != null && <span className="text-[12.5px] text-muted-foreground">deposit {fmtNear(state.launchMin + YOCTO)}</span>}
          </div>
          <p className="text-[12.5px] text-muted-foreground">The deposit pays for the coin's storage on chain, a small reserve and 1 Ⓝ of thinking budget for its brain.</p>
        </form>
      </Card>
    </section>
  );
}
