// Checks the project's claims against NEAR testnet and this repo, from a terminal: the same seven
// checks as the app's Verify page. Read-only: no key, no wallet, no install (Node 18 or newer).
//   node scripts/verify.mjs
// Prints PASS or FAIL per check and exits 0 only if every check passes.
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cfg = JSON.parse(readFileSync(join(root, "web/config.testnet.json"), "utf8"));
const REPO = cfg.repo || "SCARPxVeNOM/KillerCoins";
const NODES = [cfg.rpc, "https://test.rpc.fastnear.com", "https://rpc.testnet.fastnear.com", "https://near-testnet.drpc.org"]
  .map((u) => u.replace(/\/$/, "")).filter((u, i, all) => all.indexOf(u) === i);
const NODE_TROUBLE = /INTERNAL_ERROR|TIMEOUT_ERROR|NO_SYNCED_BLOCKS|NODE_IS_SYNCING|NOT_SYNCED_YET|UNAVAILABLE_SHARD/;

// ---------- bytes ----------
const hex = (bytes) => Buffer.from(bytes).toString("hex");
const big = (bytes) => BigInt(`0x${hex(bytes) || "0"}`);
const be32 = (n) => Buffer.from(n.toString(16).padStart(64, "0"), "hex");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest();
const short = (s) => (String(s).length > 20 ? `${String(s).slice(0, 8)}…${String(s).slice(-6)}` : String(s));
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
/** NEAR shows a code hash as the base58 of its sha256. */
function base58(bytes) {
  let n = big(bytes), out = "";
  for (; n > 0n; n /= 58n) out = B58[Number(n % 58n)] + out;
  for (const b of bytes) { if (b) break; out = `1${out}`; }
  return out;
}

// ---------- keccak-256 (Ethereum's padding), for the EIP-191 signature check ----------
const MASK = (1n << 64n) - 1n;
const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n, 0x000000000000808bn, 0x0000000080000001n,
  0x8000000080008081n, 0x8000000000008009n, 0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n, 0x8000000000008002n, 0x8000000000000080n,
  0x000000000000800an, 0x800000008000000an, 0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
// Rotation of lane x + 5y.
const ROT = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14].map(BigInt);
const rotl = (v, n) => (n ? ((v << n) | (v >> (64n - n))) & MASK : v);
function keccakF(A) {
  for (const rc of RC) {
    const C = [0, 1, 2, 3, 4].map((x) => A[x] ^ A[x + 5] ^ A[x + 10] ^ A[x + 15] ^ A[x + 20]);
    for (let x = 0; x < 5; x++) {
      const D = C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1n);
      for (let y = 0; y < 25; y += 5) A[x + y] ^= D;
    }
    const B = [];
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) B[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(A[x + 5 * y], ROT[x + 5 * y]);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 25; y += 5) A[x + y] = B[x + y] ^ (~B[((x + 1) % 5) + y] & MASK & B[((x + 2) % 5) + y]);
    A[0] ^= rc;
  }
}
export function keccak256(msg) {
  const rate = 136, padded = new Uint8Array(Math.floor(msg.length / rate) * rate + rate);
  padded.set(msg);
  padded[msg.length] ^= 0x01;
  padded[padded.length - 1] ^= 0x80;
  const A = Array(25).fill(0n);
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let lane = 0n;
      for (let b = 7; b >= 0; b--) lane = (lane << 8n) | BigInt(padded[off + i * 8 + b]);
      A[i] ^= lane;
    }
    keccakF(A);
  }
  return Uint8Array.from({ length: 32 }, (_, i) => Number((A[i >> 3] >> BigInt(8 * (i & 7))) & 0xffn));
}

// ---------- secp256k1 public key recovery ----------
const P = 2n ** 256n - 2n ** 32n - 977n;
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const G = [0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n, 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n];
const mod = (a, m = P) => ((a % m) + m) % m;
function inv(a, m = P) {
  let [r0, r1, s0, s1] = [mod(a, m), m, 1n, 0n];
  while (r1) { const q = r0 / r1; [r0, r1, s0, s1] = [r1, r0 - q * r1, s1, s0 - q * s1]; }
  return mod(s0, m);
}
function pow(b, e, m = P) {
  let r = 1n;
  for (b = mod(b, m); e > 0n; e >>= 1n, b = (b * b) % m) if (e & 1n) r = (r * b) % m;
  return r;
}
// Affine points; null is the point at infinity.
function add(p, q) {
  if (!p) return q;
  if (!q) return p;
  const [x1, y1] = p, [x2, y2] = q;
  if (x1 === x2 && mod(y1 + y2) === 0n) return null;
  const l = x1 === x2 ? mod(3n * x1 * x1 * inv(2n * y1)) : mod((y2 - y1) * inv(x2 - x1));
  const x3 = mod(l * l - x1 - x2);
  return [x3, mod(l * (x1 - x3) - y1)];
}
function mul(p, k) {
  let r = null;
  for (; k > 0n; k >>= 1n, p = add(p, p)) if (k & 1n) r = add(r, p);
  return r;
}
/** The public key [x, y] that signed the 32-byte `hash` with r, s and recovery bit v. */
export function recoverKey(hash, r, s, v) {
  let y = pow(mod(r ** 3n + 7n), (P + 1n) / 4n);
  if ((y & 1n) !== BigInt(v & 1)) y = P - y;
  const ri = inv(r, N), e = mod(big(hash), N);
  return add(mul([r, y], mod(s * ri, N)), mul(G, mod(-e * ri, N)));
}
/** The Ethereum-style address that produced `signature` over `text` (EIP-191), as the coin checks it on chain. */
export function recoverSigner(text, signature) {
  const msg = Buffer.from(text, "utf8");
  const hash = keccak256(Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${msg.length}`, "utf8"), msg]));
  const sig = Buffer.from(signature.replace(/^0x/, ""), "hex");
  const [x, y] = recoverKey(hash, big(sig.subarray(0, 32)), big(sig.subarray(32, 64)), sig[64] >= 27 ? sig[64] - 27 : sig[64]);
  return `0x${hex(keccak256(Buffer.concat([be32(x), be32(y)])).slice(12))}`;
}

// ---------- the chain and the repo ----------
async function rpc(method, params) {
  let last;
  // Two rounds: a node that said "too many requests" usually answers again a moment later.
  for (const url of [...NODES, null, ...NODES]) {
    if (!url) { await new Promise((r) => setTimeout(r, 1500)); continue; }
    try {
      const r = await fetch(url, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "verify", method, params }),
      });
      if (!r.ok) throw new Error(`${new URL(url).host} answered ${r.status}`);
      const j = await r.json();
      if (j.error && NODE_TROUBLE.test(JSON.stringify(j.error))) throw new Error(`${new URL(url).host}: ${JSON.stringify(j.error).slice(0, 120)}`);
      if (j.error) throw Object.assign(new Error(JSON.stringify(j.error)), { final: true });
      return j.result;
    } catch (e) { if (e.final) throw e; last = e; }
  }
  throw last;
}
const view = async (account_id, method_name, args = {}) => {
  const res = await rpc("query", {
    request_type: "call_function", finality: "final", account_id, method_name,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
  });
  return JSON.parse(Buffer.from(res.result).toString());
};
const account = (id) => rpc("query", { request_type: "view_account", finality: "final", account_id: id });
const keysOf = (id) => rpc("query", { request_type: "view_access_key_list", finality: "final", account_id: id }).then((r) => r.keys.length);

// The public copy of a repo file, at the commit the launchpad was deployed from.
const repoUrl = (path) => `https://raw.githubusercontent.com/${REPO}/${cfg.commit}/${path}`;
async function repoFile(path) {
  const r = await fetch(repoUrl(path));
  if (!r.ok) throw new Error(`${path}: http ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

/**
 * Asks NEAR AI for a fresh attestation report (with our own nonce, so it cannot be a replay) and
 * says whether `address` is a signing key listed in it. The Intel and NVIDIA quotes in the report
 * are not checked here.
 */
async function keyInReport(address, model) {
  const q = new URLSearchParams({ signing_algo: "ecdsa", nonce: hex(randomBytes(32)) });
  if (model) { q.set("model", model); q.set("provider", "near"); }
  const r = await fetch(`https://cloud-api.near.ai/v1/attestation/report?${q}`, { headers: model ? { "x-no-aliasing": "true" } : {} });
  if (!r.ok) throw new Error(`report: http ${r.status}`);
  const rep = await r.json();
  return [rep.gateway_attestation, rep, ...(rep.model_attestations || []), ...(rep.all_attestations || [])]
    .filter(Boolean).some((a) => String(a.signing_address || "").toLowerCase() === address.toLowerCase());
}
/** The signed text is "<model>:<sha256 of request>:<sha256 of response>", or just the two hashes. */
const modelOf = (text) => String(text).split(":").slice(0, -2).join(":") || null;

// ---------- the checks: each returns { ok, detail } ----------
async function load() {
  const coins = (await view(cfg.launchpad, "list_coins", { limit: 100 })).filter((c) => c.state === "Live").map((c) => c.account_id);
  const [codeHash, brain, info] = await Promise.all([
    view(cfg.launchpad, "coin_code_hash"), view(cfg.launchpad, "get_brain"),
    Promise.all(coins.map((a) => view(a, "coin_info"))),
  ]);
  return { coins, codeHash, brain, sym: Object.fromEntries(coins.map((a, i) => [a, info[i].symbol])) };
}

const GROUPS = ["Nobody controls it", "It runs the published code", "The AI's answers are genuine"];
const CHECKS = [
  {
    group: 0,
    title: "Nobody owns the launchpad",
    run: async () => {
      const n = await keysOf(cfg.launchpad);
      return { ok: n === 0, detail: `${cfg.launchpad} has ${n} access key${n === 1 ? "" : "s"}` };
    },
  },
  {
    group: 0,
    title: "No coin has a key",
    run: async ({ coins, sym }) => {
      const counts = await Promise.all(coins.map(keysOf));
      return { ok: coins.length > 0 && counts.every((n) => n === 0), detail: coins.map((a, i) => `$${sym[a]} ${counts[i]}`).join(" · ") };
    },
  },
  {
    group: 1,
    title: "The launchpad runs the code in the repo",
    run: async () => {
      const [chain, repo] = await Promise.all([account(cfg.launchpad).then((a) => a.code_hash), repoFile("res/autocto_launchpad.wasm").then((b) => base58(sha256(b)))]);
      return { ok: chain === repo, detail: `on chain ${short(chain)} · repo@${cfg.commit} ${short(repo)}` };
    },
  },
  {
    group: 1,
    title: "Every coin runs the same code, and it is the code in the repo",
    run: async ({ coins, codeHash }) => {
      const hashes = await Promise.all(coins.map((a) => account(a).then((x) => x.global_contract_hash || x.code_hash)));
      const odd = coins.filter((_, i) => hashes[i] !== codeHash);
      if (odd.length) return { ok: false, detail: `different code: ${odd.join(", ")}` };
      const repo = base58(sha256(await repoFile("res/autocto_coin.wasm")));
      return { ok: repo === codeHash, detail: `${coins.length} coins with code ${short(codeHash)} · repo@${cfg.commit} ${short(repo)}` };
    },
  },
  {
    group: 1,
    title: "The brain cannot be swapped",
    run: async ({ brain }) => {
      const src = JSON.parse(brain.source);
      const pinned = src.WasmUrl?.hash || src.Project?.version_key;
      if (!pinned) return { ok: false, detail: "the brain source carries no hash" };
      const repo = hex(sha256(await repoFile("res/autocto-brain.wasm")));
      return { ok: repo === pinned, detail: `pinned ${short(pinned)} · repo@${cfg.commit} ${short(repo)}` };
    },
  },
  {
    group: 1,
    title: "The rules are the published rules",
    run: async () => {
      const file = cfg.params_file || "params/testnet.json";
      const [chain, repo] = await Promise.all([view(cfg.launchpad, "get_params"), repoFile(file).then((b) => JSON.parse(b))]);
      const diff = Object.keys(repo).filter((k) => String(repo[k]) !== String(chain[k]));
      return { ok: diff.length === 0, detail: diff.length ? `differs: ${diff.join(", ")}` : `${Object.keys(repo).length} values equal ${file}` };
    },
  },
  {
    group: 2,
    title: "The latest model answer is signed by its enclave",
    run: async ({ coins, sym }) => {
      const lists = await Promise.all(coins.map((a) => view(a, "list_decisions", { limit: 12 })));
      const signed = lists.flatMap((list, i) => list.map((d) => {
        try { return { coin: coins[i], d, a: JSON.parse(d.output).attest }; } catch (_) { return {}; }
      })).filter((x) => x.a).sort((x, y) => (BigInt(y.d.answered_at || 0) > BigInt(x.d.answered_at || 0) ? 1 : -1))[0];
      if (!signed) return { ok: false, detail: "no model-mode decision among the recent ones" };
      const { a, coin, d } = signed;
      const who = `$${sym[coin]} decision #${d.id}`;
      if (recoverSigner(a.text, a.signature).toLowerCase() !== a.signing_address.toLowerCase()) return { ok: false, detail: `${who}: the signature does not match the stated key` };
      const listed = await keyInReport(a.signing_address, a.kind === "provider_tee" ? modelOf(a.text) : null);
      return { ok: listed, detail: `${who}: signature valid${d.signed_by ? " (also checked by the contract)" : ""}, key ${short(a.signing_address)} ${listed ? "is" : "is not"} in NEAR AI's current report` };
    },
  },
];

async function main() {
  const tty = process.stdout.isTTY && !process.env.NO_COLOR;
  const paint = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
  const started = Date.now();
  console.log(`Checking ${cfg.launchpad} on NEAR testnet against github.com/${REPO} at ${cfg.commit}\n`);
  let ctx;
  try { ctx = await load(); } catch (e) {
    console.log(paint(31, `FAIL  could not read the launchpad: ${e.message}`));
    process.exit(1);
  }
  const results = await Promise.all(CHECKS.map((c) => c.run(ctx).catch((e) => ({ ok: false, detail: `could not check: ${e.message}` }))));
  GROUPS.forEach((g, k) => {
    console.log(paint(2, g));
    CHECKS.forEach((c, i) => {
      if (c.group !== k) return;
      console.log(`  ${results[i].ok ? paint(32, "PASS") : paint(31, "FAIL")}  ${c.title}`);
      console.log(paint(2, `        ${results[i].detail}`));
    });
  });
  const passed = results.filter((r) => r.ok).length, secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\n${passed === CHECKS.length ? paint(32, `OK: ${passed} of ${CHECKS.length} checks passed`) : paint(31, `${CHECKS.length - passed} of ${CHECKS.length} checks failed`)} (${secs} s)`);
  console.log(paint(2, "Not checked here: the Intel and NVIDIA hardware quotes. outlayer-verify checks those (README, \"Signed AI answers\")."));
  process.exit(passed === CHECKS.length ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
