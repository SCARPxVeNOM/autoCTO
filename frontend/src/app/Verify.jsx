// Verify view: the project's claims, checked live against the chain and the public repo by this page.
import { useCallback, useEffect, useState } from "react";
import { Check, CircleAlert, LoaderCircle, Minus, RotateCw, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import { PageHead, Pill } from "@/components/common";
import { keyInReport, parseSigned, recoverSigner } from "@/lib/attest";
import { cfg, rpc, sameCode, state, sym, view } from "@/lib/chain";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
/** NEAR shows a code hash as the base58 of its sha256. */
function base58(bytes) {
  let n = BigInt(`0x${hex(bytes) || "0"}`), out = "";
  for (; n > 0n; n /= 58n) out = B58[Number(n % 58n)] + out;
  for (const b of bytes) { if (b) break; out = `1${out}`; }
  return out;
}
const short = (s) => (String(s).length > 20 ? `${String(s).slice(0, 8)}…${String(s).slice(-6)}` : String(s));
const account = (id) => rpc("query", { request_type: "view_account", finality: "final", account_id: id });
const keysOf = (id) => rpc("query", { request_type: "view_access_key_list", finality: "final", account_id: id }).then((r) => r.keys.length);

// The public copy of a repo file, at the commit the launchpad was deployed from.
const repoUrl = (path) => `https://raw.githubusercontent.com/${cfg.repo || "SCARPxVeNOM/autoCTO"}/${cfg.commit}/${path}`;
async function repoSha(path) {
  const r = await fetch(repoUrl(path));
  if (!r.ok) throw new Error(`${path}: http ${r.status}`);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", await r.arrayBuffer()));
}
const SKIP_REPO = { ok: null, detail: "This network has no pinned commit to compare with (the local demo is built from your own checkout). Open the testnet to run this check." };

/** Each check returns { ok: true | false | null (not applicable), detail }. `group` is what it proves. */
const GROUPS = ["Nobody controls it", "It runs the published code", "The AI's answers are genuine"];
const CHECKS = [
  {
    group: 0,
    title: "Nobody owns the launchpad",
    why: "An account with no access keys cannot be signed for by anyone, so its code and rules can never change.",
    run: async () => {
      const n = await keysOf(cfg.launchpad);
      const detail = `${cfg.launchpad} has ${n} access key${n === 1 ? "" : "s"}`;
      // The local demo never deletes its launchpad key: there is nothing to protect on a throwaway chain.
      if (n && cfg.dev_key) return { ok: null, detail: `${detail}. The local demo keeps it; on testnet the key is deleted after deploying.` };
      return { ok: n === 0, detail };
    },
  },
  {
    group: 1,
    title: "The launchpad runs the code in the repo",
    why: "The page downloads the contract file from GitHub, hashes it, and compares it with the hash of the code on chain.",
    run: async () => {
      if (!cfg.commit) return SKIP_REPO;
      const [chain, repo] = await Promise.all([account(cfg.launchpad).then((a) => a.code_hash), repoSha("res/autocto_launchpad.wasm").then(base58)]);
      return { ok: chain === repo, detail: `on chain ${short(chain)} · repo@${cfg.commit} ${short(repo)}` };
    },
  },
  {
    group: 1,
    title: "Every coin runs the same code, and it is the code in the repo",
    why: "Coins are created by the launchpad from one fixed contract. No coin can be a special case.",
    run: async () => {
      const coins = state.coins.map((c) => c.account_id);
      const odd = coins.filter((a) => sameCode(a) === false);
      if (odd.length) return { ok: false, detail: `different code: ${odd.join(", ")}` };
      if (!cfg.commit) return { ok: true, detail: `${coins.length} coins, all with code ${short(state.codeHash)} (not compared with a repo copy on this network)` };
      const repo = base58(await repoSha("res/autocto_coin.wasm"));
      return { ok: repo === state.codeHash, detail: `${coins.length} coins with code ${short(state.codeHash)} · repo@${cfg.commit} ${short(repo)}` };
    },
  },
  {
    group: 0,
    title: "No coin has a key",
    why: "Not the launchpad, not the person who launched it, not us: no one can move a coin's funds or mint its tokens by hand.",
    run: async () => {
      const coins = state.coins.map((c) => c.account_id);
      if (!coins.length) return { ok: null, detail: "No coins launched here yet." };
      const counts = await Promise.all(coins.map(keysOf));
      return { ok: counts.every((n) => n === 0), detail: coins.map((a, i) => `$${sym(a)} ${counts[i]}`).join(" · ") };
    },
  },
  {
    group: 1,
    title: "The brain cannot be swapped",
    why: "The launchpad stores the sha256 of the brain program. OutLayer refuses to run anything else for these coins.",
    run: async () => {
      const src = JSON.parse(state.brain.source);
      const pinned = src.WasmUrl?.hash || src.Project?.version_key;
      if (!pinned) return { ok: false, detail: "the brain source carries no hash" };
      if (!cfg.commit) return { ok: null, detail: `pinned to ${short(pinned)}. ${SKIP_REPO.detail}` };
      const repo = hex(await repoSha("res/autocto-brain.wasm"));
      return { ok: repo === pinned, detail: `pinned ${short(pinned)} · repo@${cfg.commit} ${short(repo)}` };
    },
  },
  {
    group: 1,
    title: "The rules are the published rules",
    why: "The limits on price, votes and brain spending that the launchpad enforces are the ones in the repo's params file.",
    run: async () => {
      if (!cfg.commit) return SKIP_REPO;
      const file = cfg.params_file || "params/testnet.json";
      const [chain, repo] = await Promise.all([view(cfg.launchpad, "get_params"), fetch(repoUrl(file)).then((r) => r.json())]);
      const diff = Object.keys(repo).filter((k) => String(repo[k]) !== String(chain[k]));
      return { ok: diff.length === 0, detail: diff.length ? `differs: ${diff.join(", ")}` : `${Object.keys(repo).length} values equal ${file}` };
    },
  },
  {
    group: 2,
    title: "The latest model answer is signed by its enclave",
    why: "In model mode the answer carries NEAR AI Cloud's signature. The page recovers the signer and looks the key up in a fresh attestation report.",
    run: async () => {
      const signed = Object.entries(state.decisions).flatMap(([coin, list]) => list.map((d) => {
        try { return { coin, d, a: JSON.parse(d.output).attest }; } catch (_) { return {}; }
      })).filter((x) => x.a).sort((x, y) => (BigInt(y.d.answered_at || 0) > BigInt(x.d.answered_at || 0) ? 1 : -1))[0];
      if (!signed) return { ok: null, detail: "No model-mode decision among the recent ones here: these brains ran on their fixed rules." };
      const { a, coin, d } = signed;
      const who = `$${sym(coin)} decision #${d.id}`;
      if (recoverSigner(a.text, a.signature).toLowerCase() !== a.signing_address.toLowerCase()) return { ok: false, detail: `${who}: the signature does not match the stated key` };
      const rep = await keyInReport(a.signing_address, a.kind === "provider_tee" ? parseSigned(a.text).model : null);
      return { ok: rep.listed, detail: `${who}: signature valid${d.signed_by ? " (also checked by the contract)" : ""}, key ${short(a.signing_address)} ${rep.listed ? "is" : "is not"} in NEAR AI's current report` };
    },
  },
];

// [icon, tone, label] for a passed, failed, not applicable and still running check.
const STATUS = {
  true: [Check, "up", "passed"],
  false: [CircleAlert, "down", "failed"],
  null: [Minus, "muted", "not applicable"],
  wait: [LoaderCircle, "brand", "checking"],
};
const DISC = { up: "bg-up/15 text-up", down: "bg-down/15 text-down", muted: "bg-muted text-muted-foreground", brand: "bg-primary/15 text-primary" };

function CheckRow({ c, r }) {
  const [Icon, tone, label] = STATUS[r ? String(r.ok) : "wait"];
  return (
    <Card className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3.5 gap-y-2.5 rounded-2xl p-4 shadow-none sm:grid-cols-[auto_minmax(0,1fr)_auto]">
      <span className={cn("grid size-8 place-items-center rounded-full", DISC[tone])}><Icon className={cn("size-4", !r && "animate-spin")} strokeWidth={r?.ok ? 3 : 2} /></span>
      <div className="grid gap-1">
        <b className="font-display text-[15.5px] font-semibold leading-snug">{c.title}</b>
        <p className="text-[13.5px] text-muted-foreground">{c.why}</p>
      </div>
      <Pill tone={tone} className="self-start max-sm:col-start-2 max-sm:justify-self-start">{label}</Pill>
      <p className="col-start-2 break-words rounded-lg bg-muted/60 px-2.5 py-1.5 font-mono text-[12px] text-muted-foreground sm:col-span-2">{r ? r.detail : "asking the chain…"}</p>
    </Card>
  );
}

export default function Verify() {
  const [res, setRes] = useState({});
  const [at, setAt] = useState(null);
  const run = useCallback(() => {
    setRes({}); setAt(null);
    let left = CHECKS.length;
    CHECKS.forEach((c, i) => c.run().catch((e) => ({ ok: null, detail: `could not check: ${e.message}` })).then((r) => {
      setRes((s) => ({ ...s, [i]: r }));
      if (--left === 0) setAt(new Date());
    }));
  }, []);
  useEffect(run, [run]);
  const done = Object.values(res), all = done.length === CHECKS.length;
  const passed = done.filter((r) => r.ok === true).length, failed = done.filter((r) => r.ok === false).length, skipped = done.filter((r) => r.ok === null).length;
  const [Big, tone] = !all ? [LoaderCircle, "brand"] : failed ? [CircleAlert, "down"] : [ShieldCheck, "up"];
  const headline = !all ? `Checking… ${done.length} of ${CHECKS.length}`
    : failed ? `${failed} of ${CHECKS.length} checks failed`
    : skipped ? `${passed} checks passed, ${skipped} not applicable here` : `All ${passed} checks passed`;
  const against = cfg.commit ? <>the chain and the public repo at <code className="font-mono text-foreground">{cfg.commit.slice(0, 7)}</code></> : "the chain";
  return (
    <>
      <PageHead icon={ShieldCheck} title="Verify" lede="Don't take our word for it. Your browser checks each claim below against the chain and the public code, right now. No server of ours is involved.">
        <Button variant="outline" className="rounded-full" onClick={run} disabled={!all}><RotateCw /> Run again</Button>
      </PageHead>
      <section id="verify" className="grid gap-6 px-6 pb-8 pt-6 max-sm:px-4">
        <Card className={cn("gap-3.5 rounded-2xl p-5 shadow-none", all && (failed ? "border-down/40 bg-down/[0.05]" : "border-up/40 bg-up/[0.05]"))} role="status">
          <div className="flex items-center gap-4">
            <span className={cn("grid size-12 flex-none place-items-center rounded-full", DISC[tone])}><Big className={cn("size-6", !all && "animate-spin")} /></span>
            <div className="grid gap-0.5">
              <b className="font-display text-xl font-semibold">{headline}</b>
              <span className="text-[13.5px] text-muted-foreground">{at ? <>Checked at {at.toLocaleTimeString()} against {against}.</> : <>Asking {against}…</>}</span>
            </div>
          </div>
          <Progress value={(done.length / CHECKS.length) * 100} className={cn("h-1.5", all && (failed ? "[&>*]:bg-down" : "[&>*]:bg-up"))} />
        </Card>
        {GROUPS.map((g, k) => (
          <div key={g} className="grid gap-2.5">
            <h2 className="font-mono text-[11.5px] font-medium uppercase tracking-[0.08em] text-muted-foreground">{g}</h2>
            {CHECKS.map((c, i) => c.group === k && <CheckRow key={c.title} c={c} r={res[i]} />)}
          </div>
        ))}
        <p className="max-w-[72ch] text-[13px] text-muted-foreground">Not checked here: the Intel and NVIDIA hardware quotes. Every brain decision under <a className="text-primary underline" href="#brains">Brains</a> has a proof that links to the verifiers that do.</p>
      </section>
    </>
  );
}
