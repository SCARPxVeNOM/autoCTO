// Checks NEAR AI Cloud's signature over one model call, in the browser.
// The signed text is "<model>:<sha256 of request>:<sha256 of response>" (or just the two
// hashes when the gateway signed), signed EIP-191 style by a key that lives in an enclave.
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from "@noble/hashes/utils";

const API = "https://cloud-api.near.ai/v1";

/** The Ethereum-style address that produced `signature` over `text`. */
export function recoverSigner(text, signature) {
  const msg = utf8ToBytes(text);
  const hash = keccak_256(concatBytes(utf8ToBytes(`\x19Ethereum Signed Message:\n${msg.length}`), msg));
  const sig = hexToBytes(signature.replace(/^0x/, ""));
  const v = sig[64] >= 27 ? sig[64] - 27 : sig[64];
  const pub = secp256k1.Signature.fromCompact(sig.slice(0, 64)).addRecoveryBit(v).recoverPublicKey(hash).toRawBytes(false);
  return `0x${bytesToHex(keccak_256(pub.slice(1)).slice(-20))}`;
}

/** Splits the signed text into its parts. */
export function parseSigned(text) {
  const parts = String(text).split(":");
  const [response, request] = [parts.pop(), parts.pop()];
  return { model: parts.join(":") || null, request, response };
}

/**
 * Asks NEAR AI for a fresh attestation report (with our own nonce, so it cannot be a replay)
 * and says whether `address` is a signing key listed in it. The Intel and NVIDIA quotes in the
 * report are not checked here.
 */
export async function keyInReport(address, model) {
  const nonce = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
  const q = new URLSearchParams({ signing_algo: "ecdsa", nonce });
  if (model) { q.set("model", model); q.set("provider", "near"); }
  const r = await fetch(`${API}/attestation/report?${q}`, { headers: model ? { "x-no-aliasing": "true" } : {} });
  if (!r.ok) throw new Error(`report: http ${r.status}`);
  const rep = await r.json();
  const want = address.toLowerCase();
  const listed = [rep.gateway_attestation, rep, ...(rep.model_attestations || []), ...(rep.all_attestations || [])]
    .filter(Boolean).some((a) => String(a.signing_address || "").toLowerCase() === want);
  return { listed, fresh: JSON.stringify(rep).includes(nonce) };
}
