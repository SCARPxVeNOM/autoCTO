// Coin icons are pinned on IPFS. data/icons.json maps a coin symbol to its CID and names the gateway.
import { useSyncExternalStore } from "react";

let coins = {};
let gateway = "";
const subs = new Set();
fetch("data/icons.json")
  .then((r) => (r.ok ? r.json() : {}))
  .then((j) => { coins = j.coins || {}; gateway = j.gateway || ""; for (const f of subs) f(); })
  .catch(() => {});

/** The icon's address for a symbol, or null when it has none. */
export function iconUrl(symbol) {
  const cid = coins[String(symbol || "").toUpperCase()];
  return cid && gateway ? `${gateway}${cid}` : null;
}

/** Re-renders the caller once the icon list has loaded. */
export const useIcons = () => useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => coins);
