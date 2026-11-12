// Records the landing arena's script from the chain into web/data/arena-<network>.json.
// The landing reads the chain itself; this copy is only what it plays when the node doesn't answer.
//   node scripts/record-arena.mjs [network]     (default testnet; uses web/config.<network>.json)
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { reader, readReplay } from "../frontend/src/landing/replay.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const network = process.argv[2] || "testnet";
const cfg = JSON.parse(readFileSync(join(ROOT, `web/config.${network}.json`), "utf8"));
const view = reader(cfg.rpc);
const coins = (await view(cfg.launchpad, "list_coins", { limit: 100 })).filter((c) => c.state === "Live");
const infos = await Promise.all(coins.map((c) => view(c.account_id, "coin_info")));
const replay = await readReplay(view, coins, infos, await view(cfg.launchpad, "get_params"));
if (!replay?.beats.length) throw new Error(`no takeover to record on ${cfg.launchpad}`);
const out = join(ROOT, `web/data/arena-${network}.json`);
writeFileSync(out, JSON.stringify({ launchpad: cfg.launchpad, ...replay }, null, 1) + "\n");
console.log(`${replay.beats.length} beats from ${cfg.launchpad} -> ${out}`);
