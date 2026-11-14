// Guest accounts: lets a visitor try KillerCoins on testnet without a wallet.
// The page makes a key pair and sends only the public half. This creates <random>.<GUEST_ACCOUNT>
// with that key and a little test NEAR from GUEST_ACCOUNT, so every later call is signed in the
// visitor's browser, never here. Off unless GUEST_ACCOUNT and GUEST_KEY are set in the host's settings.
//
//   GUEST_ACCOUNT  a funded testnet account, e.g. try.you.testnet (guests become its sub-accounts)
//   GUEST_KEY      a full-access key of that account, ed25519:...
//   GUEST_NEAR     test NEAR given to each guest (default 1)
//   GUEST_RPC      RPC node (default FastNEAR testnet)
import { randomBytes } from "node:crypto";
import { Account } from "near-api-js";

const { GUEST_ACCOUNT: PARENT, GUEST_KEY: KEY } = process.env;
const GIFT = process.env.GUEST_NEAR || "1";
const RPC = process.env.GUEST_RPC || "https://test.rpc.fastnear.com";
const YOCTO = 10n ** 24n;
const toYocto = (near) => { const [i, f = ""] = String(near).split("."); return BigInt(i) * YOCTO + BigInt(f.padEnd(24, "0").slice(0, 24) || "0"); };
// Kept back for the funder's own gas, so it never empties itself.
const RESERVE = YOCTO / 2n;
// One guest per address per 4 minutes, remembered while this instance stays warm.
const AGAIN_MS = 4 * 60 * 1000;
const lastFrom = new Map();

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const on = !!(PARENT && KEY);
  if (req.method === "GET") return res.status(200).json({ enabled: on, near: GIFT });
  if (req.method !== "POST") return res.status(405).json({ error: "use GET or POST" });
  if (!on) return res.status(503).json({ error: "Guest accounts are switched off here." });

  const pk = String(req.body?.public_key || "");
  if (!/^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(pk)) return res.status(400).json({ error: "public_key must be an ed25519 key" });
  const ip = String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").split(",")[0].trim();
  const now = Date.now();
  if (now - (lastFrom.get(ip) || 0) < AGAIN_MS) return res.status(429).json({ error: "One guest account per visitor every 4 minutes. Use the one you have, or connect a wallet." });
  // Claimed before any await, so requests sent in parallel from one address cannot all pass.
  lastFrom.set(ip, now);

  try {
    const funder = new Account(PARENT, RPC, KEY);
    const gift = toYocto(GIFT);
    const { balance } = await funder.getState();
    if (balance.available < gift + RESERVE) {
      lastFrom.delete(ip);
      return res.status(503).json({ error: "The guest pot is empty for now. Connect a testnet wallet instead." });
    }
    // 8 random letters and digits: enough that two visitors never pick the same name.
    const label = [...randomBytes(8)].map((b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("");
    const account = `${label}.${PARENT}`;
    await funder.createSubAccount({ accountOrPrefix: account, publicKey: pk, nearToTransfer: gift });
    return res.status(200).json({ account, near: GIFT });
  } catch (e) {
    lastFrom.delete(ip);
    console.error("guest", e);
    return res.status(502).json({ error: "Could not create the guest account. Try again in a minute." });
  }
}
