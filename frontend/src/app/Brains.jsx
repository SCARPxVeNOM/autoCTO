// Brains & feed view: what each coin's AI decided, and everything that happened on chain.
import { useEffect, useState } from "react";
import { Brain, Check, CircleAlert, LoaderCircle, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { Ago, More, Pill, SectionHead, useTick } from "@/components/common";
import { keyInReport, parseSigned, recoverSigner } from "@/lib/attest";
import { NETWORK, cfg, describeAction, humanize, state, statusName, sym } from "@/lib/chain";

const Pre = (p) => <pre className="max-h-[220px] overflow-auto whitespace-pre-wrap break-all rounded-xl border bg-muted/60 px-3 py-2.5 font-mono text-xs leading-normal" {...p} />;

const attestOf = (d) => { try { return JSON.parse(d.output).attest || null; } catch (_) { return null; } };

const Row = ({ ok, children }) => (
  <li className="flex items-start gap-2">
    {ok == null ? <LoaderCircle className="mt-0.5 size-4 flex-none animate-spin text-primary" /> : ok ? <Check className="mt-0.5 size-4 flex-none text-up" strokeWidth={3} /> : <CircleAlert className="mt-0.5 size-4 flex-none text-down" />}
    <span>{children}</span>
  </li>
);

// In model mode the answer carries NEAR AI Cloud's signature. Both checks run here, in the browser.
function ModelProof({ a, onChain }) {
  const { model, request, response } = parseSigned(a.text);
  const [signer, setSigner] = useState(undefined);
  const [report, setReport] = useState(undefined);
  useEffect(() => {
    let live = true;
    try { setSigner(recoverSigner(a.text, a.signature)); } catch (_) { setSigner(null); }
    keyInReport(a.signing_address, a.kind === "provider_tee" ? model : null).then((r) => live && setReport(r), () => live && setReport(null));
    return () => { live = false; };
  }, [a.text, a.signature, a.signing_address, a.kind, model]);
  const sigOk = signer === undefined ? null : !!signer && signer.toLowerCase() === a.signing_address.toLowerCase();
  const repOk = report === undefined ? null : !!report?.listed;
  return (
    <div className="grid gap-2 rounded-xl border border-primary/35 bg-primary/[0.06] px-3.5 py-3">
      <b className="flex items-center gap-1.5 font-display text-[15px] font-semibold"><ShieldCheck className="size-4 text-primary" /> The model's answer is signed</b>
      <p className="text-sm text-muted-foreground">{model ? <code className="font-mono text-foreground">{model}</code> : "A model"} on NEAR AI Cloud decided this. {a.kind === "provider_tee" ? "Its sealed hardware" : "NEAR AI's sealed gateway"} signed the exact question and answer.</p>
      <Pre>question sha256 = {request}{"\n"}answer sha256   = {response}{"\n"}signed by       = {a.signing_address}</Pre>
      <ul className="grid gap-1.5 text-sm">
        {onChain && <Row ok={onChain.toLowerCase() === a.signing_address.toLowerCase()}>The coin's contract checked this signature itself before acting.</Row>}
        <Row ok={sigOk}>{sigOk === false ? "The signature does not match the stated key." : "Signature valid (checked in your browser)."}</Row>
        <Row ok={repOk}>{report === null ? "Could not reach NEAR AI to fetch its attestation report." : repOk === false ? "That key is not in NEAR AI's current attestation report. Keys rotate, so an old decision can fail this check." : <>Key listed in NEAR AI's fresh attestation report{report?.fresh === false && " (the report did not echo our nonce)"}.</>}</Row>
      </ul>
      <p className="text-[12.5px] text-muted-foreground">Not checked here: the Intel TDX and NVIDIA quotes inside that report. <a className="text-primary underline" href="https://cloud.near.ai/verify" target="_blank" rel="noopener">NEAR AI's verifier</a> does that.</p>
    </div>
  );
}

// How anyone can check one brain decision.
function Verify({ pick, onClose }) {
  const d = pick && (state.decisions[pick.coin] || []).find((x) => x.id === pick.id);
  return (
    <Dialog open={!!d} onOpenChange={(o) => !o && onClose()}>
      {d && (
        <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-[680px]">
          <DialogHeader><DialogTitle>Proof for decision #{d.id} of ${sym(pick.coin)}</DialogTitle>
            <DialogDescription>The coin stored a hash of exactly what it showed the brain.</DialogDescription></DialogHeader>
          <Pre>input_sha256 = {d.input_sha256}</Pre>
          <More label="How this ties to the hardware">
          <p className="text-sm text-muted-foreground">The brain was fixed when the coin launched and runs on <code className="font-mono text-foreground">{state.brain.outlayer}</code> inside sealed hardware.</p>
          <ol className="grid list-decimal gap-1.5 pl-5 text-sm text-muted-foreground marker:font-mono marker:text-primary">
            <li><b className="font-medium text-foreground">The hardware is checked on chain, once.</b> OutLayer's worker registers its Intel TDX quote with a NEAR contract, which checks Intel's signature chain and the approved code measurements.</li>
            <li><b className="font-medium text-foreground">Only that worker can deliver results.</b> Its registered key is the only one allowed to resolve an execution on OutLayer's contract.</li>
            <li><b className="font-medium text-foreground">The coin listens to nobody else.</b> An answer can only reach it as the reply to its own call, so no account can speak in the brain's voice.</li>
            <li><b className="font-medium text-foreground">Each run has its own attestation.</b> It binds the brain's code, this input hash and the output. OutLayer keeps it off chain, because checking a quote on every call costs too much gas. <a className="text-primary underline" href="https://app.outlayer.ai/docs/tee-attestation" target="_blank" rel="noopener">How to check one</a>.</li>
          </ol>
          <Pre>brain: {state.brain.source}</Pre>
          </More>
          {attestOf(d) && <ModelProof a={attestOf(d)} onChain={d.signed_by} />}
          <p className="text-sm text-muted-foreground">What the contract received, and what it did:</p>
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
  const [all, setAll] = useState(false);
  const decisions = [];
  for (const [coin, list] of Object.entries(state.decisions)) for (const d of list) decisions.push({ coin, d });
  decisions.sort((a, b) => Number(BigInt(b.d.requested_at) - BigInt(a.d.requested_at)));
  const events = [];
  for (const [coin, h] of Object.entries(state.history)) for (const e of h) events.push({ coin, ...e });
  events.sort((a, b) => Number(BigInt(b.at) - BigInt(a.at)));
  return (
    <section className="grid lg:grid-cols-2">
      <div id="brains" className="min-w-0 pb-8 pt-6">
        <SectionHead title="Brain decisions" />
        {!decisions.length ? <p className="px-6 text-muted-foreground max-sm:px-4">No brain has been woken yet.</p> : (
          <div className="grid gap-2.5 px-6 max-sm:px-4">
            {decisions.slice(0, all ? 20 : 5).map(({ coin, d }) => {
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
                  {out ? <><div className="font-medium">{describeAction(coin, out.action)}</div><div className="line-clamp-2 break-words text-muted-foreground" title={humanize(out.thought)}>“{humanize(out.thought)}”</div></>
                    : st === "Pending" && <div className="text-muted-foreground">Thinking… the answer arrives in a few seconds.</div>}
                  <div className="text-[12.5px] text-muted-foreground">
                    <Ago ns={d.requested_at} /> · {out?.attest && <span className="inline-flex items-center gap-1 text-primary"><ShieldCheck className="size-3.5" />signed · </span>}<button type="button" className="text-primary underline underline-offset-2" onClick={() => setPick({ coin, id: d.id })}>proof</button>
                  </div>
                </Card>
              );
            })}
            {decisions.length > 5 && <Button variant="ghost" size="sm" className="justify-self-start" onClick={() => setAll(!all)}>{all ? "Show fewer" : `Show all ${Math.min(20, decisions.length)}`}</Button>}
          </div>
        )}
      </div>
      <div id="feed" className="min-w-0 border-dashed border-line pb-8 pt-6 max-lg:border-t lg:border-l">
        <SectionHead title="Live feed" note={<span className="inline-flex items-center gap-1.5"><i className="blink size-[7px] rounded-full bg-down" />live</span>} />
        <ScrollArea className="h-[520px] border-t">
          <ol>
            {!events.length && <li className="px-6 py-3 text-muted-foreground">Nothing has happened yet.</li>}
            {events.slice(0, 25).map((e, k) => (
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
