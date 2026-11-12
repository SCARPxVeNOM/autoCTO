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
  ["a tender ballot counts tokens locked after it", "tender.rs", "let weight = self.weight_at(&who, t.created_at);", "let weight = self.locked_of(&who);"],
  ["backing a tender does not hold the lock", "tender.rs", "self.extend_vote_lock(&who, t.deadline);", ""],
  ["tender veto line on today's supply", "tender.rs", "let base = t.buyer_supply.0.min(self.circulating() + self.owed());", "let base = self.circulating() + self.owed();"],
  ["no dilution check at settlement", "tender.rs", "} else if mint > bps_of(base, self.params.tender_max_dilution_bps) {", "} else if false {"],
  ["deposits taken after the deadline", "tender.rs", "require!(t.status == TenderStatus::Open && self.now() < t.deadline, \"the tender is closed\");\n        let accepted", "require!(t.status == TenderStatus::Open, \"the tender is closed\");\n        let accepted"],
  ["dust deposits accepted", "tender.rs", "cur > 0 || accepted >= t.threshold.0 / 100,", "true,"],
  ["a refund the token refused is lost", "tender.rs", "self.tender_deposits.insert(key, cur + amount.0);", ""],
  ["a stuck tender cancelled a second early", "tender.rs", "require!(self.now() > t.created_at + 600 * NS_PER_SEC,", "require!(self.now() >= t.created_at + 600 * NS_PER_SEC,"],
  ["a reveal skips the commitment", "takeover.rs", "require!(opened == ballot.commitment, \"vote and salt do not match the commitment\");", ""],
  ["the reveal window never closes", "takeover.rs", "require!(now < reveal_ends, \"the reveal window is closed\");", ""],
  ["the vote closes during the reveals", "takeover.rs", "now >= o.vote_ends + self.params.reveal_period_sec * NS_PER_SEC,", "true,"],
  ["a sealed vote holds the lock only to the vote's end", "takeover.rs", "self.extend_vote_lock(&who, reveal_ends);", "self.extend_vote_lock(&who, reveal_ends - self.params.reveal_period_sec * NS_PER_SEC);"],
  ["unrevealed votes count toward the quorum", "takeover.rs", "let turnout = o.yes.0 + o.no.0;", "let turnout = o.yes.0 + o.no.0 + o.sealed.0;"],
  ["a tender opens without being registered", "tender.rs", "if matches!(env::promise_result_checked(0, 0), Err(PromiseError::Failed)) {", "if false {"],
  ["the target applies a counter the buyer never saw", "takeover.rs", "require!(counter.rate_ppm == rate_ppm, \"the counter changed since the buyer accepted it\");", ""],
  ["the buyer accepts a counter that changed", "takeover.rs", "if seen.is_some_and(|r| r != rate.0) {", "if false {"],
  ["a deposit under the brain fee is kept", "brain.rs", "require!(attached == 0 || attached >= fee,", "require!(true,"],
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
