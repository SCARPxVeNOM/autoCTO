// The demo's "play a takeover" run: a button to start it and a panel that follows it across views.
import { Check, CircleAlert, LoaderCircle, Play, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { Left } from "@/components/common";
import { cfg, state } from "@/lib/chain";
import { closeAuto, playTakeover } from "@/lib/autoplay";

export function PlayButton({ className, ...props }) {
  if (!cfg.dev_key) return null;
  return <Button size="sm" className={cn("rounded-full", className)} disabled={state.auto?.running} onClick={playTakeover} {...props}><Play /> Play a takeover for me</Button>;
}

export function AutoPanel() {
  const a = state.auto;
  if (!a) return null;
  return (
    <Card role="status" className="fixed bottom-4 right-4 z-40 w-[min(360px,calc(100vw-32px))] gap-2.5 rounded-[18px] p-4 shadow-xl max-sm:bottom-2 max-sm:right-2">
      <div className="flex items-center gap-2">
        <b className="font-display text-[15px] font-semibold">{a.running ? "Playing a takeover" : a.error ? "The takeover stopped" : "Takeover finished"}</b>
        {!a.running && <Button variant="ghost" size="icon-xs" className="ml-auto" aria-label="Close" onClick={closeAuto}><X /></Button>}
      </div>
      <ol className="grid max-h-[46vh] gap-1.5 overflow-y-auto text-[13.5px]">
        {a.steps.map((s, k) => {
          const stopped = !s.done && !a.running;
          return (
            <li key={k} className={cn("flex items-start gap-2", s.done && k < a.steps.length - 1 && "text-muted-foreground")}>
              {s.done ? <Check className="mt-0.5 size-4 flex-none text-up" strokeWidth={3} /> : stopped ? <CircleAlert className="mt-0.5 size-4 flex-none text-down" /> : <LoaderCircle className="mt-0.5 size-4 flex-none animate-spin text-primary" />}
              <span>{s.text}{!s.done && a.until && <b className="ml-1 font-mono font-medium">{<Left ns={a.until} />}</b>}</span>
            </li>
          );
        })}
      </ol>
      {a.error && <p className="rounded-xl bg-down/10 px-3 py-2 text-[13px] text-down">{a.error}</p>}
      <p className="text-[12px] text-muted-foreground">Every step is a real transaction on the local demo chain, signed by its play-money holders.</p>
    </Card>
  );
}
