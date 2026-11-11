import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs) {
  return twMerge(clsx(inputs));
}

// ?network= picks the config file. Without it, a page served from this machine
// talks to the local demo and a hosted page talks to testnet.
const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]", ""];
export const NETWORK = new URLSearchParams(location.search).get("network")
  || (LOCAL_HOSTS.includes(location.hostname) ? "local" : "testnet");
