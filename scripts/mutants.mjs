// Breaks the coin's rules one at a time and checks that the unit tests notice.
//   node scripts/mutants.mjs
// Each mutant changes one line of contracts/coin/src, runs `cargo test -p autocto-coin --lib`
// and puts the line back. A mutant the tests pass is "MISSED": a rule nothing checks.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (f) => join(root, "contracts/coin/src", f);

const MUTANTS = [
  ["a lock in the same block as the bid votes", "market.rs", ".filter(|l| l.since < t)", ".filter(|l| l.since <= t)"],
  ["a folded lot keeps its old timestamp", "market.rs", "lots.push(Lot { amount: U128(last.amount.0 + amount), since: now });", "lots.push(Lot { amount: U128(last.amount.0 + amount), since: last.since });"],
  ["sells skip the fee", "market.rs", "let out = gross - fee;", "let out = gross;"],
  ["quorum on today's supply", "takeover.rs", "let quorum = bps_of(o.target_market.circulating.0, self.params.quorum_bps);", "let quorum = bps_of(self.circulating(), self.params.quorum_bps);"],
  ["approval one token stricter", "takeover.rs", "if o.yes.0 < bps_of(turnout, self.params.approval_bps) {", "if o.yes.0 <= bps_of(turnout, self.params.approval_bps) {"],
  ["voting does not hold the lock", "takeover.rs", "        self.extend_vote_lock(&who, vote_ends);\n", "\n"],
  ["a counter keeps the old votes", "takeover.rs", "        o.yes = U128(0);\n        o.no = U128(0);\n        o.sealed = U128(0);\n", ""],
  ["premium cap one basis point loose", "takeover.rs", "if premium > self.params.max_premium_bps as i64 {", "if premium > self.params.max_premium_bps as i64 + 1 {"],
  ["veto line on today's supply", "takeover.rs", "let veto_base = o.buyer_market.circulating.0.min(self.circulating());", "let veto_base = self.circulating();"],
  ["a veto must pass the line, not reach it", "takeover.rs", "if o.veto.0 > 0 && o.veto.0 >= bps_of(veto_base, self.params.veto_bps) {", "if o.veto.0 > 0 && o.veto.0 > bps_of(veto_base, self.params.veto_bps) {"],
  ["no price check at execution", "takeover.rs", "if premium_bps(o.rate_ppm.0, fair_now) > self.params.max_premium_bps as i64 {", "if false {"],
  ["the merge keeps the treasury", "takeover.rs", "let total = curve_real + treasury;", "let total = curve_real;"],
  ["absorb trusts the stated curve NEAR", "takeover.rs", "self.amm_near += curve_near.0.min(deposit);", "self.amm_near += curve_near.0;"],
  ["converting skips locked tokens", "takeover.rs", "let total = free + locked;", "let total = free;"],
  ["no cap on conversions", "takeover.rs", "a.converted.0 + amount.0 <= a.max_target_amount.0,", "true,"],
  ["the cap leaves out unconverted holders", "takeover.rs", "let claims = U128(self.circulating() + self.owed());", "let claims = U128(self.circulating());"],
  ["a tender needs no backing", "tender.rs", "} else if t.backing.0 == 0 || t.backing.0 < bps_of(base, self.params.quorum_bps) {", "} else if false {"],
];

let missed = 0;
for (const [name, file, from, to] of MUTANTS) {
  const original = readFileSync(src(file), "utf8");
  if (original.split(from).length !== 2) throw new Error(`${name}: the line to change is not in ${file} exactly once`);
  writeFileSync(src(file), original.replace(from, to));
  let r;
  try {
    r = spawnSync("cargo", ["test", "-q", "-p", "autocto-coin", "--lib"], { cwd: root, encoding: "utf8" });
  } finally {
    writeFileSync(src(file), original);
  }
  const out = r.stdout + r.stderr;
  if (out.includes("error[")) throw new Error(`${name}: the mutant does not compile\n${out}`);
  const caughtBy = [...out.matchAll(/^ {4}tests::(\w+)$/gm)].map((m) => m[1]);
  if (r.status === 0) missed++;
  console.log(`${r.status === 0 ? "MISSED" : "caught"}  ${name}${caughtBy.length ? `: ${caughtBy.join(", ")}` : ""}`);
}
console.log(`${MUTANTS.length - missed} of ${MUTANTS.length} mutants caught`);
process.exit(missed ? 1 : 0);
