// Verify view: the project's claims, checked live against the chain and the public repo by this page.
import { useCallback, useEffect, useState } from "react";
import { Check, CircleAlert, LoaderCircle, Minus, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { SectionHead } from "@/components/common";
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

/** Each check returns { ok: true | false | null (not applicable), detail }. */
const CHECKS = [
  {
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
    title: "The launchpad runs the code in the repo",
    why: "The page downloads the contract file from GitHub, hashes it, and compares it with the hash of the code on chain.",
    run: async () => {
      if (!cfg.commit) return SKIP_REPO;
      const [chain, repo] = await Promise.all([account(cfg.launchpad).then((a) => a.code_hash), repoSha("res/autocto_launchpad.wasm").then(base58)]);
      return { ok: chain === repo, detail: `on chain ${short(chain)} · repo@${cfg.commit} ${short(repo)}` };
    },
  },
  {
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
      return { ok: rep.listed, detail: `${who}: signature valid, key ${short(a.signing_address)} ${rep.listed ? "is" : "is not"} in NEAR AI's current report` };
    },
  },
];

const ICON = {
  wait: <LoaderCircle className="size-5 animate-spin text-primary" />,
  true: <Check className="size-5 text-up" strokeWidth={3} />,
  false: <CircleAlert className="size-5 text-down" />,
  null: <Minus className="size-5 text-muted-foreground" />,
};

export default function Verify() {
  const [res, setRes] = useState({});
  const run = useCallback(() => {
    setRes({});
    CHECKS.forEach((c, i) => c.run().catch((e) => ({ ok: null, detail: `could not check: ${e.message}` })).then((r) => setRes((s) => ({ ...s, [i]: r }))));
  }, []);
  useEffect(run, [run]);
  const done = Object.values(res), all = done.length === CHECKS.length;
  const passed = done.filter((r) => r.ok === true).length, failed = done.filter((r) => r.ok === false).length, skipped = done.filter((r) => r.ok === null).length;
  return (
    <section id="verify" className="pb-8 pt-6">
      <SectionHead title="Verify it yourself" note={all ? `${passed} passed${failed ? ` · ${failed} failed` : ""}${skipped ? ` · ${skipped} not applicable` : ""}` : "checking…"}>
        <Button variant="outline" size="sm" onClick={run} disabled={!all}><RotateCw className="size-3.5" />Run again</Button>
      </SectionHead>
      <div className="grid gap-4 px-6 max-sm:px-4">
        <p className="max-w-[72ch]">Your browser checks each claim against the chain{cfg.commit ? " and the public repo" : ""}, right now. No server of ours is involved.</p>
        <div className="grid gap-2.5">
          {CHECKS.map((c, i) => {
            const r = res[i];
            return (
              <Card key={c.title} title={c.why} className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 rounded-2xl px-4 py-3 shadow-none">
                <span className="row-span-2 mt-0.5">{ICON[r ? String(r.ok) : "wait"]}</span>
                <b className="font-display text-[15px] font-semibold">{c.title}</b>
                <p className="break-words font-mono text-[12.5px] text-muted-foreground">{r ? r.detail : "…"}</p>
              </Card>
            );
          })}
        </div>
        <p className="max-w-[72ch] text-[13px] text-muted-foreground">Not checked here: the Intel and NVIDIA hardware quotes. The proof under <a className="text-primary underline" href="#brains">Brains</a> links to the verifiers that do.</p>
      </div>
    </section>
  );
}
