// Brains & feed view: what each coin's AI decided, and everything that happened on chain.
import { useState } from "react";
import { Brain } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { Ago, Pill, SectionHead, useTick } from "@/components/common";
import { NETWORK, cfg, describeAction, fmtNear, humanize, short, state, statusName, sym } from "@/lib/chain";

const Pre = (p) => <pre className="max-h-[220px] overflow-auto whitespace-pre-wrap break-all rounded-xl border bg-muted/60 px-3 py-2.5 font-mono text-xs leading-normal" {...p} />;

// How anyone can check one brain decision.
function Verify({ pick, onClose }) {
  const d = pick && (state.decisions[pick.coin] || []).find((x) => x.id === pick.id);
  return (
    <Dialog open={!!d} onOpenChange={(o) => !o && onClose()}>
      {d && (
        <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-[680px]">
          <DialogHeader><DialogTitle>Proof for decision #{d.id} of ${sym(pick.coin)}</DialogTitle>
            <DialogDescription>When the brain was woken, the coin hashed the exact input it handed over and stored it on chain.</DialogDescription></DialogHeader>
          <Pre>input_sha256 = {d.input_sha256}</Pre>
          <p className="text-sm text-muted-foreground">The brain was fixed when the coin launched. It runs on <code className="font-mono text-foreground">{state.brain.outlayer}</code> inside sealed hardware whose attestation commits to the code, this input and the output. The answer can only reach the coin as the reply to its own call.</p>
          <Pre>brain: {state.brain.source}</Pre>
          <p className="text-sm text-muted-foreground">The answer the contract received, and what it did with it:</p>
          <Pre>{d.output || "(none)"}</Pre>
          <Pre>status: {JSON.stringify(d.status)}</Pre>
          <p className="text-[12.5px] text-muted-foreground">
            Check it yourself: {cfg.explorer && <><a className="text-primary underline" href={`${cfg.explorer}/address/${pick.coin}`} target="_blank" rel="noopener">the coin's transactions</a>, </>}
            <a className="text-primary underline" href="https://app.outlayer.ai/workspace" target="_blank" rel="noopener">OutLayer executions</a>.
            {NETWORK === "local" && " Locally, a stand-in for OutLayer logs the same input hash and the output's hash."}
          </p>
        </DialogContent>
      )}
    </Dialog>
  );
}

const EV_TONE = { trade: "text-up bg-up/15", lock: "text-warn bg-warn/15", unlock: "text-warn bg-warn/15", vote: "text-warn bg-warn/15", vote_sealed: "text-warn bg-warn/15", think: "text-primary bg-primary/15", thought: "text-primary bg-primary/15", stance: "text-primary bg-primary/15", veto: "text-down bg-down/15" };

export default function Brains() {
  useTick();
  const [pick, setPick] = useState(null);
  const decisions = [];
  for (const [coin, list] of Object.entries(state.decisions)) for (const d of list) decisions.push({ coin, d });
  decisions.sort((a, b) => Number(BigInt(b.d.requested_at) - BigInt(a.d.requested_at)));
  const events = [];
  for (const [coin, h] of Object.entries(state.history)) for (const e of h) events.push({ coin, ...e });
  events.sort((a, b) => Number(BigInt(b.at) - BigInt(a.at)));
  return (
    <section className="grid lg:grid-cols-2">
      <div id="brains" className="min-w-0 pb-8 pt-6">
        <SectionHead title="Brain decisions" note="what each coin's AI decided, and why" />
        {!decisions.length ? <p className="px-6 text-muted-foreground max-sm:px-4">No brain has been woken yet. Open a coin and press Think.</p> : (
          <div className="grid gap-2.5 px-6 max-sm:px-4">
            {decisions.slice(0, 20).map(({ coin, d }) => {
              let out = null;
              try { out = JSON.parse(d.output); } catch (_) {}
              const st = statusName(d.status);
              const tone = { Applied: "up", Pending: "brand", Refused: "down", NoAnswer: "down" }[st] || "muted";
              return (
                <Card key={`${coin}|${d.id}`} className="gap-1.5 rounded-2xl px-4 py-3.5 text-sm shadow-none">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <b className="inline-flex items-center gap-1.5 font-display text-[15px] font-semibold"><Brain className="size-4 text-primary" /> ${sym(coin)} <span className="font-normal text-muted-foreground">#{d.id}</span></b>
                    <Pill tone={tone} className="whitespace-normal">{st === "Refused" ? `refused: ${d.status.Refused.reason}` : st === "Applied" ? "done" : st.toLowerCase()}</Pill>
                  </div>
                  {out ? <><div className="break-words">“{humanize(out.thought)}”</div><div className="font-medium">→ {describeAction(coin, out.action)}</div></>
                    : st === "Pending" && <div className="text-muted-foreground">Thinking… the answer arrives in a few seconds.</div>}
                  <div className="text-[12.5px] text-muted-foreground">
                    <Ago ns={d.requested_at} /> · woken by {short(d.requested_by)} · cost {fmtNear(d.paid)}{d.paid_by_treasury ? " from the treasury" : ""} · <button type="button" className="text-primary underline underline-offset-2" onClick={() => setPick({ coin, id: d.id })}>proof</button>
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </div>
      <div id="feed" className="min-w-0 border-dashed border-line pb-8 pt-6 max-lg:border-t lg:border-l">
        <SectionHead title="Live feed" note={<span className="inline-flex items-center gap-1.5"><i className="blink size-[7px] rounded-full bg-down" />everything that happens, as it happens</span>} />
        <ScrollArea className="h-[720px] border-t">
          <ol>
            {!events.length && <li className="px-6 py-3 text-muted-foreground">Nothing has happened yet.</li>}
            {events.slice(0, 120).map((e, k) => (
              <li key={`${e.coin}|${e.at}|${e.event}|${k}`} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-baseline gap-x-2.5 gap-y-1 border-b px-6 py-2 text-[13.5px] max-sm:px-4">
                <span className={cn("whitespace-nowrap rounded-md px-1.5 py-px font-mono text-[11px] font-medium", EV_TONE[e.event] || "bg-muted text-muted-foreground")}>${sym(e.coin)} {e.event.replace(/_/g, " ")}</span>
                <span className="break-words text-muted-foreground">{humanize(e.text)}</span>
                <span className="whitespace-nowrap font-mono text-[11.5px] text-muted-foreground"><Ago ns={e.at} /></span>
              </li>
            ))}
          </ol>
        </ScrollArea>
      </div>
      <Verify pick={pick} onClose={() => setPick(null)} />
    </section>
  );
}
