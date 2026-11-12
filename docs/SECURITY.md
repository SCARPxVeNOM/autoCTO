# Contract checklist

Both contracts were checked against the detector list of NEAR's [`near-contract-audit`](https://github.com/near/agent-skills) skill, by reading and pattern search. This is not an audit. The rules, what each one stops and the tests behind them are in the [README](../README.md#security).

| Check | Result |
|---|---|
| Callbacks are `#[private]` | pass: all 7 in the coin (`on_brain`, `on_execute`, `on_converted`, `on_offer_sent`, `on_counter_applied`, `on_tender_opened`, `on_tender_refund`) and `on_launched` in the launchpad |
| `#[init]` on constructors | pass: both; the launchpad's is also `#[private]` |
| Storage prefixes collide | pass: one `BorshStorageKey` enum per contract |
| Owner checks on sensitive methods | not applicable: there is no owner and no setter; coin-to-coin calls check that the caller is a direct sub-account of the same launchpad, which only the launchpad can create |
| One yocto on methods that move a holder's tokens | pass for `sell` and `convert`; `lock`, `unlock`, `vote` and `veto` take no deposit on purpose, so they can be relayed gaslessly |
| Amounts cross JSON as strings | pass: `U128` everywhere; ids and timestamps are `u64` |
| Overflow | pass: `overflow-checks = true` in the release profile; curve math runs in 256 bits |
| Floats in money math | pass: none |
| Randomness from block data | pass: none used |
| Gas reserved for callbacks | pass: every callback has static gas (10 to 80 Tgas) |
| State changed after a cross-contract call | by design in the merge and tender flows; each one moves through an explicit status (`Executing`, `Sending`, `Opening`) and its callback rolls back on failure. Covered by the end-to-end tests and by unit tests of each failure path (`a_failed_execution_reopens_the_target_and_starts_the_cooldown`, `a_refused_conversion_is_refunded_in_full`, `a_token_that_reports_no_supply_fails_the_tender`, `a_tender_opens_only_if_the_token_registers_the_coin`, `a_stuck_tender_can_be_cancelled_after_ten_minutes`, `a_refund_the_token_refuses_stays_claimable`), not formally verified |
| Unbounded loops over user data | open: finished bids and tenders are never pruned (see the README's Limitations). Lock lots and watchlists are capped at 8 |
| Storage paid by the caller | open: votes and decisions are paid by the coin |
