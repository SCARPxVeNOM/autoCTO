//! Unit tests on near-sdk's mocked chain: one coin at a time, its sibling's
//! calls played by switching the caller and the clock. Each test takes
//! milliseconds, so the rules are checked at their exact lines (a quorum met
//! to the last token, a lock in the same block as the bid). `tests/` runs whole
//! takeovers between real coins in a sandbox.

use std::cell::Cell;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::Once;

use near_contract_standards::fungible_token::FungibleTokenCore;
use near_contract_standards::fungible_token::receiver::FungibleTokenReceiver;
use near_sdk::json_types::U128;
use near_sdk::mock::MockAction;
use near_sdk::serde_json::{self, Value};
use near_sdk::test_utils::{VMContextBuilder, get_created_receipts};
use near_sdk::{AccountId, NearToken, PromiseError, PromiseOrValue, PromiseResult, testing_env};

use crate::Coin;
use crate::math::{U256, bps_of, fair_rate_ppm, mul_div};
use crate::types::*;

const NEAR: u128 = 10u128.pow(24);
const TOKEN: u128 = 10u128.pow(18);
const SUPPLY: u128 = 1_000_000_000 * TOKEN;
const VIRTUAL: u128 = 30 * NEAR;
const T0: u64 = 1_800_000_000 * NS_PER_SEC;

const LAUNCHPAD: &str = "v4.autocto.testnet";
const PEPE: &str = "pepe.v4.autocto.testnet";
const DOGE: &str = "doge.v4.autocto.testnet";
const SHIB: &str = "shib.v4.autocto.testnet";
const OLD: &str = "old.testnet";
const ALICE: &str = "alice.testnet";
const BOB: &str = "bob.testnet";
const CAROL: &str = "carol.testnet";
const DAVE: &str = "dave.testnet";

fn id(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn at(sec: u64) -> u64 {
    T0 + sec * NS_PER_SEC
}

/// The demo rules, as in `tests/` and the local demo: 60 s votes, quorum 10%,
/// approval 67%, veto 10%, premium and discount caps 30%, newborn protection 30 s.
fn params() -> Params {
    Params {
        total_supply: U128(SUPPLY),
        virtual_near: U128(VIRTUAL),
        trade_fee_bps: 100,
        max_premium_bps: 3000,
        max_discount_bps: 3000,
        max_dilution_bps: 10_000,
        vote_period_sec: 60,
        quorum_bps: 1000,
        approval_bps: 6700,
        veto_bps: 1000,
        proposer_bps: 100,
        rebid_cooldown_sec: 120,
        max_offers_per_day: 3,
        newborn_protection_sec: 30,
        brain_fee: U128(NEAR / 20),
        brain_daily_cap: U128(NEAR),
        think_cooldown_sec: 5,
        reserve: U128(NEAR / 2),
        tender_period_sec: 60,
        tender_threshold_bps: 4000,
        tender_max_dilution_bps: 2000,
        reveal_period_sec: 0,
    }
}

fn context(coin: &str, who: &str, sec: u64, deposit: u128) -> near_sdk::VMContext {
    VMContextBuilder::new()
        .current_account_id(id(coin))
        .predecessor_account_id(id(who))
        .signer_account_id(id(who))
        .block_timestamp(at(sec))
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .build()
}

/// Sets up the mocked chain for one call. Building the VM config is most of
/// that work, so it is built once per thread.
fn mock(context: near_sdk::VMContext, promise_results: Vec<PromiseResult>) {
    thread_local!(static CONFIG: Box<dyn std::any::Any> =
        Box::new((near_sdk::test_vm_config(), near_sdk::RuntimeFeesConfig::test())));
    fn cached<T: Clone + 'static>(any: &dyn std::any::Any) -> T {
        any.downcast_ref::<T>().unwrap().clone()
    }
    let (config, fees) = CONFIG.with(|c| cached(&**c));
    testing_env!(context, config, fees, Default::default(), promise_results);
}

/// The next call reaches `coin` from `who`, `sec` seconds after launch.
fn call(coin: &str, who: &str, sec: u64, deposit: u128) {
    mock(context(coin, who, sec, deposit), vec![]);
}

/// A fresh coin, launched at second 0 on an empty chain.
fn launch(coin: &str) -> Coin {
    near_sdk::mock::with_mocked_blockchain(|b| drop(b.take_storage()));
    call(coin, LAUNCHPAD, 0, 0);
    let label = coin.split('.').next().unwrap();
    let brain =
        BrainConfig { outlayer: id("outlayer.testnet"), source: "{}".into(), secrets_ref: None, max_instructions: 1 };
    Coin::new(label.into(), label.to_uppercase(), None, String::new(), id("dev.testnet"), params(), brain)
}

fn buy(c: &mut Coin, coin: &str, who: &str, sec: u64, near: u128) -> u128 {
    call(coin, who, sec, near);
    c.buy(None).0
}

fn lock(c: &mut Coin, coin: &str, who: &str, sec: u64, amount: u128) {
    call(coin, who, sec, 0);
    c.lock(U128(amount));
}

/// `who` locks everything they hold.
fn lock_all(c: &mut Coin, coin: &str, who: &str, sec: u64) {
    let all = balance(c, who);
    lock(c, coin, who, sec, all);
}

fn balance(c: &Coin, who: &str) -> u128 {
    c.ft_balance_of(id(who)).0
}

/// Why `f` was refused (panicked), or None if it went through. Prints nothing.
fn refusal<R>(f: impl FnOnce() -> R) -> Option<String> {
    thread_local!(static QUIET: Cell<bool> = const { Cell::new(false) });
    static HOOK: Once = Once::new();
    HOOK.call_once(|| {
        let default = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            if !QUIET.with(Cell::get) {
                default(info)
            }
        }));
    });
    QUIET.with(|q| q.set(true));
    let r = catch_unwind(AssertUnwindSafe(f)).err();
    QUIET.with(|q| q.set(false));
    r.map(|e| {
        e.downcast_ref::<String>()
            .cloned()
            .or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string()))
            .unwrap_or_default()
    })
}

/// True when `f` is refused, for any reason.
fn refused<R>(f: impl FnOnce() -> R) -> bool {
    refusal(f).is_some()
}

/// Fails unless `f` is refused with a message that contains `why`.
#[track_caller]
fn assert_refused<R>(why: &str, f: impl FnOnce() -> R) {
    match refusal(f) {
        Some(m) => assert!(m.contains(why), "refused with {m:?}, expected {why:?}"),
        None => panic!("went through, expected a refusal: {why:?}"),
    }
}

/// Function calls the last call scheduled on `to`: (args, attached yoctoNEAR).
fn calls_to(to: &str, method: &str) -> Vec<(Value, u128)> {
    get_created_receipts()
        .into_iter()
        .filter(|r| r.receiver_id == id(to))
        .flat_map(|r| r.actions)
        .filter_map(|a| match a {
            MockAction::FunctionCallWeight { method_name, args, attached_deposit, .. }
                if method_name == method.as_bytes() =>
            {
                Some((serde_json::from_slice(&args).unwrap(), attached_deposit.as_yoctonear()))
            }
            _ => None,
        })
        .collect()
}

fn closed(r: PromiseOrValue<bool>) -> bool {
    match r {
        PromiseOrValue::Value(v) => v,
        PromiseOrValue::Promise(_) => true,
    }
}

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        self.0 >> 33
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

// ---------- the target's side: bids, the snapshot rule and the vote ----------

/// PEPE's numbers as it reports them when it bids: bigger and pricier than DOGE.
fn pepe_market() -> MarketSnapshot {
    MarketSnapshot {
        amm_near: U128(60 * NEAR),
        amm_tokens: U128(500_000_000 * TOKEN),
        circulating: U128(500_000_000 * TOKEN),
        owed: U128(0),
    }
}

/// DOGE with alice and bob each holding 3 NEAR of it, bought at second 1.
fn doge() -> Coin {
    let mut c = launch(DOGE);
    buy(&mut c, DOGE, ALICE, 1, 3 * NEAR);
    buy(&mut c, DOGE, BOB, 1, 3 * NEAR);
    c
}

fn fair_of(c: &Coin) -> u128 {
    let m = pepe_market();
    fair_rate_ppm(c.amm_near, c.amm_tokens, m.amm_near.0, m.amm_tokens.0)
}

/// PEPE's bid number `offer_id` lands on DOGE at `sec`; returns its key.
fn bid_at_rate(c: &mut Coin, sec: u64, offer_id: u64, rate: u128) -> String {
    call(DOGE, PEPE, sec, 0);
    c.receive_offer(
        offer_id,
        U128(rate),
        "Join the frog.".into(),
        Proposer::Brain { decision_id: offer_id },
        pepe_market(),
    );
    offer_key(&id(PEPE), offer_id)
}

/// PEPE bids 10% over the fair rate at `sec`.
fn bid(c: &mut Coin, sec: u64) -> (String, u128) {
    let rate = fair_of(c) * 11 / 10;
    (bid_at_rate(c, sec, 0, rate), rate)
}

#[test]
fn a_lock_made_before_the_bid_votes_with_its_full_weight() {
    let mut c = doge();
    let a = balance(&c, ALICE);
    lock(&mut c, DOGE, ALICE, 10, a);
    let (key, _) = bid(&mut c, 40);
    call(DOGE, ALICE, 41, 0);
    assert_eq!(c.vote(key.clone(), true).0, a);
    assert_eq!(c.get_incoming(key).unwrap().yes.0, a);
}

#[test]
#[should_panic(expected = "no tokens locked before this offer was announced")]
fn a_lock_made_after_the_bid_cannot_vote() {
    let mut c = doge();
    let (key, _) = bid(&mut c, 40);
    lock_all(&mut c, DOGE, BOB, 41);
    call(DOGE, BOB, 42, 0);
    c.vote(key, false);
}

#[test]
#[should_panic(expected = "no tokens locked before this offer was announced")]
fn a_lock_in_the_same_block_as_the_bid_cannot_vote() {
    let mut c = doge();
    lock_all(&mut c, DOGE, BOB, 40);
    let (key, _) = bid(&mut c, 40);
    call(DOGE, BOB, 41, 0);
    c.vote(key, false);
}

#[test]
fn locking_more_after_the_bid_adds_no_weight() {
    let mut c = doge();
    let a = balance(&c, ALICE);
    lock(&mut c, DOGE, ALICE, 10, a / 2);
    let (key, _) = bid(&mut c, 40);
    lock(&mut c, DOGE, ALICE, 45, a - a / 2);
    call(DOGE, ALICE, 46, 0);
    assert_eq!(c.vote(key, true).0, a / 2);
    assert_eq!(c.locked_of(&id(ALICE)), a);
}

#[test]
fn folding_lock_lots_can_only_lower_a_vote() {
    let mut c = doge();
    let q = balance(&c, ALICE) / 16;
    for sec in 2..2 + MAX_LOTS as u64 {
        lock(&mut c, DOGE, ALICE, sec, q);
    }
    let (key, _) = bid(&mut c, 40);
    let before = c.weight_at(&id(ALICE), at(40));
    assert_eq!(before, 8 * q);
    // A ninth lot folds into the newest one, which takes the new timestamp.
    lock(&mut c, DOGE, ALICE, 41, q);
    assert_eq!(c.locks_of(id(ALICE)).len(), MAX_LOTS);
    assert_eq!(c.locked_of(&id(ALICE)), 9 * q);
    assert_eq!(c.weight_at(&id(ALICE), at(40)), 7 * q);
    call(DOGE, ALICE, 42, 0);
    assert_eq!(c.vote(key, true).0, 7 * q);
}

#[test]
#[should_panic(expected = "already voted in this round")]
fn a_holder_votes_once_per_round() {
    let mut c = doge();
    lock_all(&mut c, DOGE, ALICE, 10);
    let (key, _) = bid(&mut c, 40);
    call(DOGE, ALICE, 41, 0);
    c.vote(key.clone(), true);
    call(DOGE, ALICE, 42, 0);
    c.vote(key, true);
}

#[test]
#[should_panic(expected = "these tokens back a vote that has not ended")]
fn tokens_that_voted_stay_locked_until_the_vote_ends() {
    let mut c = doge();
    let a = balance(&c, ALICE);
    lock(&mut c, DOGE, ALICE, 10, a);
    let (key, _) = bid(&mut c, 40);
    call(DOGE, ALICE, 41, 0);
    c.vote(key, true);
    call(DOGE, ALICE, 99, 0);
    c.unlock(U128(a));
}

#[test]
fn tokens_that_voted_unlock_when_the_vote_ends() {
    let mut c = doge();
    let a = balance(&c, ALICE);
    lock(&mut c, DOGE, ALICE, 10, a);
    let (key, _) = bid(&mut c, 40);
    call(DOGE, ALICE, 41, 0);
    c.vote(key, true);
    call(DOGE, ALICE, 100, 0);
    c.unlock(U128(a));
    assert_eq!((balance(&c, ALICE), c.total_locked), (a, 0));
}

#[test]
#[should_panic(expected = "voting is closed")]
fn votes_after_the_period_are_refused() {
    let mut c = doge();
    lock_all(&mut c, DOGE, ALICE, 10);
    let (key, _) = bid(&mut c, 40);
    call(DOGE, ALICE, 100, 0);
    c.vote(key, true);
}

#[test]
fn an_accepted_counter_restarts_the_vote_on_the_old_snapshot() {
    let mut c = doge();
    let a = balance(&c, ALICE);
    lock(&mut c, DOGE, ALICE, 10, a);
    let (key, rate) = bid(&mut c, 40);
    call(DOGE, ALICE, 41, 0);
    c.vote(key.clone(), true);
    // carol buys in after the bid; DOGE counters at +20%, and PEPE accepts.
    buy(&mut c, DOGE, CAROL, 50, NEAR);
    lock_all(&mut c, DOGE, CAROL, 51);
    call(DOGE, ALICE, 55, 0);
    let counter = rate * 12 / 11;
    drop(c.try_counter(key.clone(), counter, "Pay more.".into(), Proposer::Holder { account_id: id(ALICE) }).unwrap());
    call(DOGE, PEPE, 70, 0);
    let ack = c.apply_counter(0, U128(counter));
    assert_eq!((ack.round, ack.rate_ppm.0, ack.vote_ends), (1, counter, at(130)));
    let o = c.get_incoming(key.clone()).unwrap();
    assert_eq!((o.yes.0, o.no.0, o.created_at), (0, 0, at(40)), "votes reset, snapshot kept");
    // alice votes again in round 1; carol's lock is still after the snapshot.
    call(DOGE, ALICE, 71, 0);
    assert_eq!(c.vote(key.clone(), true).0, a);
    call(DOGE, CAROL, 72, 0);
    assert!(refused(|| c.vote(key.clone(), false)));
}

#[test]
fn a_counter_that_changed_before_the_acceptance_landed_is_refused() {
    let mut c = doge();
    let (key, rate) = bid(&mut c, 40);
    let by = Proposer::Holder { account_id: id(ALICE) };
    // DOGE counters at +15%; PEPE accepts that; DOGE raises to +20% before the acceptance arrives.
    let (first, second) = (rate * 115 / 110, rate * 12 / 11);
    call(DOGE, ALICE, 50, 0);
    drop(c.try_counter(key.clone(), first, "Pay more.".into(), by.clone()).unwrap());
    call(DOGE, ALICE, 51, 0);
    drop(c.try_counter(key.clone(), second, "No, more.".into(), by).unwrap());
    call(DOGE, PEPE, 52, 0);
    assert_refused("the counter changed since the buyer accepted it", || c.apply_counter(0, U128(first)));
    let o = c.get_incoming(key.clone()).unwrap();
    assert_eq!((o.round, o.rate_ppm.0, o.counter.unwrap().rate_ppm.0), (0, rate, second), "nothing changed");
    assert_eq!(c.apply_counter(0, U128(second)).rate_ppm.0, second);
}

#[test]
fn accepting_a_counter_names_the_rate_that_was_seen() {
    let (mut c, _, rate) = pepe_bids(|_| 0);
    let counter = |c: &mut Coin, sec: u64, rate: u128| {
        call(PEPE, DOGE, sec, 0);
        c.receive_counter(0, U128(rate), "Pay more.".into(), Proposer::Brain { decision_id: 0 });
    };
    let (first, second) = (rate * 115 / 110, rate * 12 / 11);
    counter(&mut c, 50, first);
    call(PEPE, ALICE, 51, 0);
    drop(c.accept_counter(0, Some(U128(first))));
    assert_eq!(calls_to(DOGE, "apply_counter")[0].0["rate_ppm"], first.to_string(), "DOGE applies only this rate");
    // DOGE raises its counter: an acceptance of the old terms is refused here already.
    counter(&mut c, 52, second);
    call(PEPE, ALICE, 53, 0);
    assert_refused("the counter changed since you saw it", || c.accept_counter(0, Some(U128(first))));
    drop(c.accept_counter(0, None));
    assert_eq!(calls_to(DOGE, "apply_counter")[0].0["rate_ppm"], second.to_string());
}

#[test]
fn a_brain_fee_is_paid_in_full_or_by_the_treasury() {
    let mut c = doge();
    let fee = params().brain_fee.0;
    call(DOGE, ALICE, 10, fee - 1);
    assert_refused("attach at least the brain fee, or nothing to let the treasury pay", || c.think());
    call(DOGE, ALICE, 10, fee);
    drop(c.think());
    let d = c.get_decision(0).unwrap();
    assert_eq!((d.paid.0, d.paid_by_treasury), (fee, false));
    assert_eq!(calls_to("outlayer.testnet", "request_execution")[0].1, fee, "all of it goes to the run");
}

#[test]
fn the_premium_cap_holds_to_the_basis_point() {
    let mut c = doge();
    let fair = fair_of(&c);
    let over = (13_001 * fair).div_ceil(10_000);
    assert!(refused(|| bid_at_rate(&mut c, 40, 0, over)), "+30.01% is over the cap");
    let key = bid_at_rate(&mut c, 40, 0, over - 1);
    assert_eq!(c.get_incoming(key).unwrap().premium_bps, 3000);
}

#[test]
fn the_discount_floor_holds_to_the_basis_point() {
    let mut c = doge();
    let fair = fair_of(&c);
    let floor = (7_000 * fair).div_ceil(10_000);
    assert!(refused(|| bid_at_rate(&mut c, 40, 0, floor - 1)), "-30.01% is under the floor");
    let key = bid_at_rate(&mut c, 40, 0, floor);
    assert_eq!(c.get_incoming(key).unwrap().premium_bps, -3000);
}

#[test]
fn only_direct_sub_accounts_of_the_launchpad_are_siblings() {
    let c = doge();
    assert!(c.is_sibling(&id(PEPE)));
    for other in
        [DOGE, LAUNCHPAD, "x.pepe.v4.autocto.testnet", "pepev4.autocto.testnet", "pepe.v5.autocto.testnet", ALICE]
    {
        assert!(!c.is_sibling(&id(other)), "{other}");
    }
}

#[test]
#[should_panic(expected = "only coins from the same launchpad can bid")]
fn an_outside_contract_cannot_bid() {
    let mut c = doge();
    let rate = fair_of(&c);
    call(DOGE, "pepe.evil.testnet", 40, 0);
    c.receive_offer(0, U128(rate), "x".into(), Proposer::Brain { decision_id: 0 }, pepe_market());
}

#[test]
#[should_panic(expected = "newborn protection")]
fn a_newborn_coin_cannot_be_bid_for() {
    let mut c = doge();
    bid(&mut c, 29);
}

#[test]
#[should_panic(expected = "one open offer per pair")]
fn one_open_offer_per_pair() {
    let mut c = doge();
    let (_, rate) = bid(&mut c, 40);
    bid_at_rate(&mut c, 41, 1, rate);
}

// ---------- closing the vote ----------

/// Quorum and the YES weight it needs, from DOGE's supply after `doge()`.
fn lines() -> (u128, u128) {
    let c = doge();
    let quorum = bps_of(c.circulating(), 1000);
    (quorum, bps_of(quorum, 6700))
}

/// DOGE where alice locks `yes` and bob locks `no` before PEPE's bid, both
/// vote, and carol closes the vote when it ends.
fn close_vote(yes: u128, no: u128) -> (Coin, String, bool) {
    let mut c = doge();
    lock(&mut c, DOGE, ALICE, 10, yes);
    lock(&mut c, DOGE, BOB, 10, no);
    let (key, _) = bid(&mut c, 40);
    call(DOGE, ALICE, 41, 0);
    c.vote(key.clone(), true);
    call(DOGE, BOB, 41, 0);
    c.vote(key.clone(), false);
    call(DOGE, CAROL, 100, 0);
    let passed = closed(c.finalize(key.clone()));
    (c, key, passed)
}

fn failure(c: &Coin, key: &str) -> String {
    match c.get_incoming(key.into()).unwrap().status {
        OfferStatus::Failed { reason } => reason,
        s => panic!("offer is {s:?}"),
    }
}

#[test]
fn exactly_quorum_and_exactly_two_thirds_pass() {
    let (quorum, yes) = lines();
    let (c, key, passed) = close_vote(yes, quorum - yes);
    assert!(passed);
    assert_eq!(c.status, CoinStatus::MergePending { into: id(PEPE) });
    assert_eq!(c.get_incoming(key).unwrap().status, OfferStatus::Executing);
    assert_eq!(calls_to(PEPE, "execute_takeover").len(), 1);
}

#[test]
fn one_token_short_of_quorum_fails() {
    let (quorum, yes) = lines();
    let (c, key, passed) = close_vote(yes, quorum - yes - 1);
    assert!(!passed);
    assert_eq!(failure(&c, &key), "quorum not reached");
    assert_eq!(c.status, CoinStatus::Active);
    assert_eq!(calls_to(PEPE, "offer_closed").len(), 1, "the buyer is told");
}

#[test]
fn one_token_short_of_two_thirds_fails() {
    let (quorum, yes) = lines();
    let (c, key, passed) = close_vote(yes - 1, quorum - yes + 1);
    assert!(!passed);
    assert_eq!(failure(&c, &key), "rejected by holders");
}

#[test]
fn buying_after_the_bid_cannot_raise_the_quorum() {
    let (quorum, _) = lines();
    let mut c = doge();
    lock(&mut c, DOGE, ALICE, 10, quorum);
    let (key, _) = bid(&mut c, 40);
    // A whale buys in after the bid: on today's supply the quorum would be over 3x higher.
    buy(&mut c, DOGE, DAVE, 41, 60 * NEAR);
    assert!(bps_of(c.circulating(), 1000) > 3 * quorum);
    call(DOGE, ALICE, 42, 0);
    c.vote(key.clone(), true);
    call(DOGE, CAROL, 100, 0);
    assert!(closed(c.finalize(key)), "quorum is measured on the supply at the bid");
}

#[test]
#[should_panic(expected = "the vote is still running")]
fn the_vote_cannot_close_early() {
    let mut c = doge();
    let (key, _) = bid(&mut c, 40);
    call(DOGE, CAROL, 99, 0);
    let _ = c.finalize(key);
}

#[test]
#[should_panic(expected = "this coin is not active")]
fn a_passed_deal_freezes_trading() {
    let (quorum, yes) = lines();
    let (mut c, _, _) = close_vote(yes, quorum - yes);
    buy(&mut c, DOGE, DAVE, 101, NEAR);
}

#[test]
fn a_failed_execution_reopens_the_target_and_starts_the_cooldown() {
    let (quorum, yes) = lines();
    let (mut c, key, _) = close_vote(yes, quorum - yes);
    call(DOGE, DOGE, 101, 0);
    assert!(!c.on_execute(key.clone(), Ok(false)));
    assert_eq!(c.status, CoinStatus::Active);
    assert_eq!(failure(&c, &key), "the buyer vetoed or could not execute");
    buy(&mut c, DOGE, DAVE, 102, NEAR);
    let rate = fair_of(&c);
    assert!(refused(|| bid_at_rate(&mut c, 101 + 119, 1, rate)), "cooldown: 120 s");
    bid_at_rate(&mut c, 101 + 120, 1, rate);
}

// ---------- merging and converting ----------

fn merged() -> (Coin, u128) {
    let (quorum, yes) = lines();
    let (mut c, key, passed) = close_vote(yes, quorum - yes);
    assert!(passed);
    let rate = c.get_incoming(key.clone()).unwrap().rate_ppm.0;
    call(DOGE, DOGE, 101, 0);
    assert!(c.on_execute(key, Ok(true)));
    (c, rate)
}

#[test]
fn a_merge_closes_the_curve_and_sends_its_near_and_treasury_to_the_buyer() {
    let (quorum, yes) = lines();
    let (mut c, key, _) = close_vote(yes, quorum - yes);
    call(DOGE, DOGE, 101, 0);
    let curve = c.amm_near - VIRTUAL;
    let treasury = c.treasury();
    assert!(curve > 0 && treasury > 0);
    assert!(c.on_execute(key.clone(), Ok(true)));
    let rate = c.get_incoming(key).unwrap().rate_ppm;
    assert_eq!(c.status, CoinStatus::Merged { into: id(PEPE), rate_ppm: rate, at: at(101) });
    assert_eq!(c.amm_near, VIRTUAL, "the curve is closed");
    let sent = calls_to(PEPE, "absorb");
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].1, curve + treasury, "every yocto of curve NEAR and treasury moves");
    assert_eq!(sent[0].0["curve_near"], curve.to_string());
    assert_eq!(sent[0].0["treasury"], treasury.to_string());
}

#[test]
fn converting_burns_free_and_locked_tokens_and_asks_the_buyer_to_mint() {
    let (mut c, _) = merged();
    let (free, locked) = (balance(&c, ALICE), c.locked_of(&id(ALICE)));
    assert!(free > 0 && locked > 0);
    let (supply, own) = (c.token.total_supply, balance(&c, DOGE));
    call(DOGE, ALICE, 102, 1);
    drop(c.convert());
    assert_eq!(c.token.total_supply, supply - free - locked, "burned exactly what alice held");
    assert_eq!(balance(&c, DOGE), own - locked);
    assert_eq!((balance(&c, ALICE), c.locked_of(&id(ALICE))), (0, 0));
    let mint = calls_to(PEPE, "mint_converted");
    assert_eq!(mint.len(), 1);
    assert_eq!(mint[0].0["account_id"], ALICE);
    assert_eq!(mint[0].0["amount"], (free + locked).to_string());
}

#[test]
fn a_refused_conversion_is_refunded_in_full() {
    let (mut c, _) = merged();
    let total = balance(&c, ALICE) + c.locked_of(&id(ALICE));
    let supply = c.token.total_supply;
    call(DOGE, ALICE, 102, 1);
    drop(c.convert());
    call(DOGE, DOGE, 103, 0);
    assert_eq!(c.on_converted(id(ALICE), U128(total), Err(PromiseError::Failed)).0, 0);
    assert_eq!(balance(&c, ALICE), total);
    assert_eq!(c.token.total_supply, supply);
}

#[test]
fn a_merged_coin_is_convert_only() {
    let (mut c, _) = merged();
    let b = balance(&c, BOB);
    call(DOGE, DAVE, 102, NEAR);
    assert!(refused(|| c.buy(None)));
    call(DOGE, BOB, 102, 1);
    assert!(refused(|| c.sell(U128(1), None)));
    call(DOGE, BOB, 102, 0);
    assert!(refused(|| c.lock(U128(1))));
    assert!(refused(|| bid_at_rate(&mut c, 102, 1, 1_000_000)));
    assert_eq!(balance(&c, BOB), b);
}

#[test]
#[should_panic(expected = "this coin has not merged")]
fn an_active_coin_cannot_convert() {
    let mut c = doge();
    call(DOGE, ALICE, 10, 1);
    drop(c.convert());
}

// ---------- the buyer's side: veto, last checks, minting ----------

/// DOGE's numbers when PEPE bids for it.
fn doge_market() -> MarketSnapshot {
    MarketSnapshot {
        amm_near: U128(36 * NEAR),
        amm_tokens: U128(833_333_334 * TOKEN),
        circulating: U128(166_666_666 * TOKEN),
        owed: U128(0),
    }
}

/// PEPE with alice (10 NEAR, all locked) and bob (5 NEAR, `bob_locks(veto
/// line)` locked) from before the bid. At second 40 alice bids 10% over fair for
/// DOGE, and DOGE opens the vote. Returns PEPE, the veto line and the rate.
fn pepe_bids(bob_locks: impl FnOnce(u128) -> u128) -> (Coin, u128, u128) {
    let mut c = launch(PEPE);
    buy(&mut c, PEPE, ALICE, 1, 10 * NEAR);
    buy(&mut c, PEPE, BOB, 1, 5 * NEAR);
    let line = bps_of(c.circulating(), 1000);
    lock_all(&mut c, PEPE, ALICE, 2);
    let b = bob_locks(line);
    if b > 0 {
        lock(&mut c, PEPE, BOB, 2, b);
    }
    let m = doge_market();
    let fair = fair_rate_ppm(m.amm_near.0, m.amm_tokens.0, c.amm_near, c.amm_tokens);
    let rate = fair * 11 / 10;
    call(PEPE, ALICE, 40, 0);
    drop(c.propose_offer(id(DOGE), U128(rate), "Join the frog.".into()));
    call(PEPE, PEPE, 40, 0);
    let ack = OfferAck {
        created_at: at(40),
        vote_ends: at(100),
        fair_rate_ppm: U128(fair),
        premium_bps: 1000,
        target_market: m,
    };
    assert!(c.on_offer_sent(0, Ok(ack)));
    (c, line, rate)
}

/// DOGE's holders approved: DOGE asks PEPE to execute at `sec`.
fn execute(c: &mut Coin, sec: u64, circulating: u128, market: MarketSnapshot) -> bool {
    call(PEPE, DOGE, sec, 0);
    c.execute_takeover(0, U128(circulating), market)
}

fn outgoing_failure(c: &Coin) -> String {
    match c.get_outgoing(0).unwrap().status {
        OfferStatus::Failed { reason } => reason,
        s => panic!("offer is {s:?}"),
    }
}

#[test]
fn a_veto_at_the_line_blocks_the_takeover() {
    let (mut c, line, _) = pepe_bids(|line| line);
    call(PEPE, BOB, 50, 0);
    assert_eq!(c.veto(0).0, line);
    assert!(!execute(&mut c, 101, doge_market().circulating.0, doge_market()));
    assert_eq!(outgoing_failure(&c), "vetoed by our holders");
    assert!(c.absorbed.is_empty() && !c.out_by_target.contains_key(&id(DOGE)));
}

#[test]
fn a_veto_one_token_under_the_line_does_not_block() {
    let (mut c, line, rate) = pepe_bids(|line| line - 1);
    call(PEPE, BOB, 50, 0);
    assert_eq!(c.veto(0).0, line - 1);
    let circ = doge_market().circulating.0;
    assert!(execute(&mut c, 101, circ, doge_market()));
    assert_eq!(c.get_outgoing(0).unwrap().status, OfferStatus::Executed);
    let a = c.absorbed.get(&id(DOGE)).unwrap();
    assert_eq!((a.max_target_amount.0, a.rate_ppm.0, a.converted.0), (circ, rate, 0));
    assert_eq!(c.owed(), mul_div(circ, rate, RATE_SCALE));
}

#[test]
fn buying_after_the_bid_cannot_raise_the_veto_line() {
    let (mut c, line, _) = pepe_bids(|line| line);
    // Deal fans buy in after the bid, so the veto line on today's supply moves out of reach.
    buy(&mut c, PEPE, CAROL, 60, 100 * NEAR);
    assert!(bps_of(c.circulating(), 1000) > 2 * line);
    call(PEPE, BOB, 61, 0);
    c.veto(0);
    assert!(!execute(&mut c, 101, doge_market().circulating.0, doge_market()));
    assert_eq!(outgoing_failure(&c), "vetoed by our holders", "the line is measured on the supply at the bid");
}

#[test]
#[should_panic(expected = "no tokens locked before this offer was announced")]
fn a_lock_made_after_the_bid_cannot_veto() {
    let (mut c, _, _) = pepe_bids(|_| 0);
    lock_all(&mut c, PEPE, BOB, 50);
    call(PEPE, BOB, 51, 0);
    c.veto(0);
}

#[test]
fn execution_rechecks_the_rate_against_prices_now() {
    let (mut c, _, _) = pepe_bids(|_| 0);
    // DOGE was dumped during the vote: the agreed rate is now 50% over fair.
    let dumped = MarketSnapshot {
        amm_near: U128(30_500_000 * NEAR / 1_000_000),
        amm_tokens: U128(983_606_558 * TOKEN),
        ..doge_market()
    };
    assert!(!execute(&mut c, 101, dumped.circulating.0, dumped));
    assert!(outgoing_failure(&c).contains("prices moved"));
}

#[test]
fn execution_rechecks_the_dilution_cap() {
    let (mut c, _, rate) = pepe_bids(|_| 0);
    let too_many = mul_div(c.circulating(), RATE_SCALE, rate) + 2 * RATE_SCALE;
    assert!(!execute(&mut c, 101, too_many, doge_market()));
    assert_eq!(outgoing_failure(&c), "dilution cap exceeded at execution");
}

#[test]
fn conversions_mint_at_the_rate_and_never_past_the_absorbed_supply() {
    let (mut c, _, rate) = pepe_bids(|_| 0);
    let circ = doge_market().circulating.0;
    assert!(execute(&mut c, 101, circ, doge_market()));
    let supply = c.token.total_supply;
    call(PEPE, DOGE, 102, 0);
    let first = c.mint_converted(id(CAROL), U128(circ / 3)).0;
    assert_eq!(first, mul_div(circ / 3, rate, RATE_SCALE));
    let second = c.mint_converted(id(DAVE), U128(circ - circ / 3)).0;
    assert_eq!(c.token.total_supply, supply + first + second, "supply grows only by the mints");
    assert_eq!((balance(&c, CAROL), balance(&c, DAVE)), (first, second));
    assert_eq!(c.owed(), 0);
    assert!(refused(|| c.mint_converted(id(DAVE), U128(1))), "past the absorbed supply");
    call(PEPE, SHIB, 103, 0);
    assert!(refused(|| c.mint_converted(id(DAVE), U128(1))), "a coin PEPE never absorbed");
}

#[test]
fn absorb_deepens_the_curve_by_at_most_what_was_sent() {
    let (mut c, _, _) = pepe_bids(|_| 0);
    assert!(execute(&mut c, 101, doge_market().circulating.0, doge_market()));
    let depth = c.amm_near;
    call(PEPE, DOGE, 102, 6 * NEAR);
    c.absorb(U128(5 * NEAR), U128(NEAR));
    assert_eq!(c.amm_near, depth + 5 * NEAR, "curve NEAR deepens the curve, treasury does not");
    call(PEPE, DOGE, 103, 3 * NEAR);
    c.absorb(U128(5 * NEAR), U128(0));
    assert_eq!(c.amm_near, depth + 8 * NEAR, "never more than the NEAR attached");
    call(PEPE, SHIB, 104, NEAR);
    assert!(refused(|| c.absorb(U128(NEAR), U128(0))));
}

#[test]
fn a_chained_takeover_leaves_no_holder_stranded() {
    // DOGE absorbs SHIB; SHIB's holders have not converted when PEPE bids for DOGE.
    let mut c = doge();
    let a = balance(&c, ALICE);
    lock(&mut c, DOGE, ALICE, 2, a);
    let shib = MarketSnapshot {
        amm_near: U128(31 * NEAR),
        amm_tokens: U128(967_741_936 * TOKEN),
        circulating: U128(32_258_064 * TOKEN),
        owed: U128(0),
    };
    let rate = fair_rate_ppm(shib.amm_near.0, shib.amm_tokens.0, c.amm_near, c.amm_tokens);
    call(DOGE, ALICE, 40, 0);
    drop(c.propose_offer(id(SHIB), U128(rate), "Join the dog.".into()));
    call(DOGE, DOGE, 40, 0);
    let ack = OfferAck {
        created_at: at(40),
        vote_ends: at(100),
        fair_rate_ppm: U128(rate),
        premium_bps: 0,
        target_market: shib.clone(),
    };
    c.on_offer_sent(0, Ok(ack));
    call(DOGE, SHIB, 101, 0);
    assert!(c.execute_takeover(0, shib.circulating, shib.clone()));
    let owed = mul_div(shib.circulating.0, rate, RATE_SCALE);
    assert_eq!(c.owed(), owed);

    // PEPE bids for DOGE; alice's lock predates it. The cap sent to PEPE covers SHIB's holders.
    let (key, _) = bid(&mut c, 200);
    call(DOGE, ALICE, 201, 0);
    c.vote(key.clone(), true);
    call(DOGE, CAROL, 260, 0);
    assert!(closed(c.finalize(key.clone())));
    let claims = c.circulating() + owed;
    let exec = calls_to(PEPE, "execute_takeover");
    assert_eq!(exec[0].0["target_circulating"], claims.to_string());
    call(DOGE, DOGE, 261, 0);
    assert!(c.on_execute(key, Ok(true)));

    // A SHIB holder converts after DOGE merged: into DOGE, then on into PEPE.
    call(DOGE, SHIB, 300, 0);
    let got = c.mint_converted(id(DAVE), U128(shib.circulating.0)).0;
    assert_eq!(got, owed);
    assert!(c.circulating() <= claims, "everything that can still convert fits under PEPE's cap");
    call(DOGE, DAVE, 301, 1);
    drop(c.convert());
    assert_eq!(calls_to(PEPE, "mint_converted")[0].0["amount"], got.to_string());
}

// ---------- tender offers ----------

/// Alice proposes a tender for OLD at `rate` and OLD gives `answers`: the
/// registration, then the supply. Returns whether it opened.
fn tender_answered(c: &mut Coin, tender_id: u64, rate: u128, answers: Vec<PromiseResult>) -> bool {
    call(PEPE, ALICE, 40, 0);
    drop(c.propose_tender(id(OLD), U128(rate), "Swap your OLD.".into()));
    mock(context(PEPE, PEPE, 40, 0), answers);
    c.on_tender_opened(tender_id)
}

/// OLD's answer to `storage_deposit` when it registers the coin.
fn registered() -> PromiseResult {
    PromiseResult::Successful(br#"{"total":"1250000000000000000000","available":"0"}"#.to_vec())
}

fn supply_answer(supply: u128) -> PromiseResult {
    PromiseResult::Successful(serde_json::to_vec(&U128(supply)).unwrap())
}

/// Alice proposes a tender for OLD at `rate`; OLD registers PEPE and
/// reports `supply`. Returns whether it opened.
fn tender(c: &mut Coin, tender_id: u64, rate: u128, supply: u128) -> bool {
    tender_answered(c, tender_id, rate, vec![registered(), supply_answer(supply)])
}

fn pepe_for_tenders() -> Coin {
    let mut c = launch(PEPE);
    buy(&mut c, PEPE, ALICE, 1, 10 * NEAR);
    buy(&mut c, PEPE, BOB, 1, 5 * NEAR);
    lock_all(&mut c, PEPE, ALICE, 2);
    c
}

/// The highest rate whose 40% threshold still fits under the 20% dilution cap.
fn top_tender_rate(c: &Coin, supply: u128) -> u128 {
    mul_div(bps_of(c.circulating(), 2000), RATE_SCALE, bps_of(supply, 4000))
}

#[test]
fn a_tender_opens_only_if_its_threshold_fits_under_the_dilution_cap() {
    let mut c = pepe_for_tenders();
    let supply = 1_000_000_000 * TOKEN;
    let top = top_tender_rate(&c, supply);
    assert!(!tender(&mut c, 0, top + 1, supply));
    assert!(matches!(c.get_tender(0).unwrap().status, TenderStatus::Failed { .. }));
    assert!(tender(&mut c, 1, top, supply));
    let t = c.get_tender(1).unwrap();
    assert_eq!(t.threshold.0, bps_of(supply, 4000));
    assert!(t.max_deposit.0 >= t.threshold.0);
}

#[test]
fn a_tender_returns_deposits_over_its_cap_and_needs_its_holders_backing() {
    let mut c = pepe_for_tenders();
    let supply = 1_000_000_000 * TOKEN;
    let rate = top_tender_rate(&c, supply);
    assert!(tender(&mut c, 0, rate, supply));
    let max = c.get_tender(0).unwrap().max_deposit.0;
    call(PEPE, OLD, 50, 0);
    let PromiseOrValue::Value(back) = c.ft_on_transfer(id(DAVE), U128(supply / 2), "0".into()) else { panic!() };
    assert_eq!(back.0, supply / 2 - max, "the excess goes back to dave");
    call(PEPE, CAROL, 100, 0);
    assert!(!c.settle_tender(0), "nobody backed it");
    assert!(matches!(c.get_tender(0).unwrap().status, TenderStatus::Failed { reason } if reason.contains("quorum")));
    call(PEPE, DAVE, 101, 0);
    let PromiseOrValue::Promise(p) = c.claim_tender(0) else { panic!("a refund is a transfer") };
    drop(p);
    assert_eq!(calls_to(OLD, "ft_transfer")[0].0["amount"], max.to_string());
}

#[test]
fn a_backed_tender_mints_exactly_its_deposits_at_the_rate() {
    let mut c = pepe_for_tenders();
    let supply = 1_000_000_000 * TOKEN;
    let rate = top_tender_rate(&c, supply);
    assert!(tender(&mut c, 0, rate, supply));
    call(PEPE, ALICE, 45, 0);
    c.back_tender(0);
    call(PEPE, OLD, 50, 0);
    let deposit = bps_of(supply, 4000);
    let _ = c.ft_on_transfer(id(DAVE), U128(deposit), "0".into());
    let before = c.token.total_supply;
    call(PEPE, CAROL, 100, 0);
    assert!(c.settle_tender(0));
    let mint = mul_div(deposit, rate, RATE_SCALE);
    assert_eq!(c.owed(), mint);
    assert!(mint <= bps_of(c.circulating(), 2000));
    call(PEPE, DAVE, 101, 0);
    assert!(matches!(c.claim_tender(0), PromiseOrValue::Value(U128(m)) if m == mint));
    assert_eq!(c.token.total_supply, before + mint);
    assert_eq!(c.owed(), 0);
    assert!(refused(|| c.claim_tender(0)), "one claim");
}

const OLD_SUPPLY: u128 = 1_000_000_000 * TOKEN;

/// `pepe_for_tenders` where bob also locks `bob_locks(veto line)` at second 3,
/// then a tender for OLD opens at the top rate at second 40 (deadline 100).
fn open_tender(bob_locks: impl FnOnce(u128) -> u128) -> Coin {
    let mut c = pepe_for_tenders();
    let b = bob_locks(bps_of(c.circulating(), 1000));
    if b > 0 {
        lock(&mut c, PEPE, BOB, 3, b);
    }
    let rate = top_tender_rate(&c, OLD_SUPPLY);
    assert!(tender(&mut c, 0, rate, OLD_SUPPLY));
    c
}

/// OLD sends `amount` of `who`'s tokens to tender 0 at `sec`; returns what came back.
fn deposit(c: &mut Coin, who: &str, sec: u64, amount: u128) -> u128 {
    call(PEPE, OLD, sec, 0);
    let PromiseOrValue::Value(back) = c.ft_on_transfer(id(who), U128(amount), "0".into()) else { panic!() };
    back.0
}

fn back(c: &mut Coin, who: &str, sec: u64) -> u128 {
    call(PEPE, who, sec, 0);
    c.back_tender(0).0
}

fn veto_tender(c: &mut Coin, who: &str, sec: u64) -> u128 {
    call(PEPE, who, sec, 0);
    c.veto_tender(0).0
}

/// Carol settles tender 0 at `sec`.
fn settle(c: &mut Coin, sec: u64) -> bool {
    call(PEPE, CAROL, sec, 0);
    c.settle_tender(0)
}

fn tender_failure(c: &Coin) -> String {
    match c.get_tender(0).unwrap().status {
        TenderStatus::Failed { reason } => reason,
        s => panic!("tender is {s:?}"),
    }
}

#[test]
fn a_lock_made_after_the_tender_cannot_back_or_veto_it() {
    let mut c = open_tender(|_| 0);
    lock_all(&mut c, PEPE, BOB, 41);
    call(PEPE, BOB, 45, 0);
    assert_refused("no tokens locked before this tender was announced", || c.back_tender(0));
    assert_refused("no tokens locked before this tender was announced", || c.veto_tender(0));
}

#[test]
fn a_lock_in_the_same_block_as_the_tender_cannot_back_it() {
    let mut c = pepe_for_tenders();
    lock_all(&mut c, PEPE, BOB, 40);
    let rate = top_tender_rate(&c, OLD_SUPPLY);
    assert!(tender(&mut c, 0, rate, OLD_SUPPLY));
    call(PEPE, BOB, 45, 0);
    assert_refused("no tokens locked before this tender was announced", || c.back_tender(0));
}

#[test]
fn a_holder_backs_or_vetoes_a_tender_once() {
    let mut c = open_tender(|line| line);
    let a = c.locked_of(&id(ALICE));
    assert_eq!(back(&mut c, ALICE, 45), a);
    call(PEPE, ALICE, 46, 0);
    assert_refused("already backed or vetoed", || c.back_tender(0));
    assert_refused("already backed or vetoed", || c.veto_tender(0));
    assert_eq!(c.get_tender(0).unwrap().backing.0, a, "counted once");
}

#[test]
fn tender_ballots_hold_the_lock_until_the_deadline() {
    // bob, not alice: proposing the tender already holds alice's lock to the deadline.
    let mut c = open_tender(|line| line);
    back(&mut c, BOB, 45);
    call(PEPE, BOB, 99, 0);
    assert_refused("these tokens back a vote that has not ended", || c.unlock(U128(1)));
    call(PEPE, BOB, 100, 0);
    let b = c.locked_of(&id(BOB));
    c.unlock(U128(b));
    assert_eq!(c.locked_of(&id(BOB)), 0);
}

#[test]
fn ballots_and_deposits_close_at_the_deadline() {
    let mut c = open_tender(|line| line);
    call(PEPE, ALICE, 100, 0);
    assert_refused("the tender is closed", || c.back_tender(0));
    call(PEPE, BOB, 100, 0);
    assert_refused("the tender is closed", || c.veto_tender(0));
    call(PEPE, OLD, 100, 0);
    assert_refused("the tender is closed", || c.ft_on_transfer(id(DAVE), U128(OLD_SUPPLY / 2), "0".into()));
    assert_eq!(c.get_tender(0).unwrap().deposited.0, 0);
}

/// A tender alice backs, dave fills to the threshold and bob vetoes with
/// `bob_locks(line)`. Returns whether it settled.
fn vetoed_tender(bob_locks: impl FnOnce(u128) -> u128) -> (Coin, bool) {
    let mut c = open_tender(bob_locks);
    back(&mut c, ALICE, 45);
    veto_tender(&mut c, BOB, 46);
    deposit(&mut c, DAVE, 50, bps_of(OLD_SUPPLY, 4000));
    let settled = settle(&mut c, 100);
    (c, settled)
}

#[test]
fn a_tender_veto_at_the_line_fails_the_tender() {
    let (c, settled) = vetoed_tender(|line| line);
    assert!(!settled);
    assert_eq!(tender_failure(&c), "vetoed by our holders");
    assert_eq!(c.owed(), 0);
}

#[test]
fn a_tender_veto_one_token_under_the_line_does_not_block() {
    let (c, settled) = vetoed_tender(|line| line - 1);
    assert!(settled);
    assert_eq!(c.get_tender(0).unwrap().status, TenderStatus::Succeeded);
}

#[test]
fn buying_after_the_tender_cannot_raise_its_veto_line() {
    let mut c = open_tender(|line| line);
    // Deal fans buy in after the tender, so the line on today's supply moves out of bob's reach.
    let line = bps_of(c.circulating(), 1000);
    buy(&mut c, PEPE, CAROL, 41, 100 * NEAR);
    assert!(bps_of(c.circulating(), 1000) > 2 * line);
    back(&mut c, ALICE, 45);
    veto_tender(&mut c, BOB, 46);
    deposit(&mut c, DAVE, 50, bps_of(OLD_SUPPLY, 4000));
    assert!(!settle(&mut c, 100));
    assert_eq!(tender_failure(&c), "vetoed by our holders", "the line is measured on the supply at the tender");
}

#[test]
fn a_tender_short_of_its_threshold_refunds_every_depositor() {
    let mut c = open_tender(|_| 0);
    back(&mut c, ALICE, 45);
    let threshold = c.get_tender(0).unwrap().threshold.0;
    deposit(&mut c, DAVE, 50, threshold / 2);
    deposit(&mut c, CAROL, 51, threshold / 2 - 1);
    assert!(!settle(&mut c, 100));
    assert_eq!(tender_failure(&c), "threshold not reached");
    for (who, amount) in [(DAVE, threshold / 2), (CAROL, threshold / 2 - 1)] {
        call(PEPE, who, 101, 0);
        drop(c.claim_tender(0));
        let refund = calls_to(OLD, "ft_transfer");
        assert_eq!(
            (refund[0].0["receiver_id"].as_str(), refund[0].0["amount"].as_str()),
            (Some(who), Some(amount.to_string().as_str()))
        );
        assert_eq!(refund[0].1, 1, "one yocto, as NEP-141 asks");
    }
    assert_eq!(c.token.total_supply, SUPPLY, "nothing was minted");
}

#[test]
fn the_dilution_cap_is_checked_again_at_settlement() {
    let mut c = open_tender(|_| 0);
    back(&mut c, ALICE, 45);
    let max = c.get_tender(0).unwrap().max_deposit.0;
    deposit(&mut c, DAVE, 50, max);
    // bob sells out during the tender: the same mint is now over 20% of a smaller supply.
    call(PEPE, BOB, 60, 1);
    c.sell(U128(balance(&c, BOB)), None);
    assert!(!settle(&mut c, 100));
    assert_eq!(tender_failure(&c), "dilution cap exceeded at settlement");
}

#[test]
#[should_panic(expected = "the deadline has not passed")]
fn a_tender_cannot_settle_before_its_deadline() {
    let mut c = open_tender(|_| 0);
    back(&mut c, ALICE, 45);
    deposit(&mut c, DAVE, 50, bps_of(OLD_SUPPLY, 4000));
    settle(&mut c, 99);
}

#[test]
fn deposits_must_come_from_the_tendered_token_and_name_an_open_tender() {
    let mut c = open_tender(|_| 0);
    let amount = bps_of(OLD_SUPPLY, 4000);
    call(PEPE, "fake.testnet", 50, 0);
    assert_refused("this tender is for another token", || c.ft_on_transfer(id(DAVE), U128(amount), "0".into()));
    call(PEPE, OLD, 50, 0);
    assert_refused("msg must be a tender id", || c.ft_on_transfer(id(DAVE), U128(amount), "deposit".into()));
    assert_refused("unknown tender", || c.ft_on_transfer(id(DAVE), U128(amount), "7".into()));
    assert_eq!(c.get_tender(0).unwrap().deposited.0, 0);
}

#[test]
fn a_first_deposit_under_one_percent_of_the_threshold_is_refused() {
    let mut c = open_tender(|_| 0);
    let dust = c.get_tender(0).unwrap().threshold.0 / 100;
    call(PEPE, OLD, 50, 0);
    assert_refused("first deposit must be at least 1% of the threshold", || {
        c.ft_on_transfer(id(DAVE), U128(dust - 1), "0".into())
    });
    assert_eq!(deposit(&mut c, DAVE, 51, dust), 0);
    assert_eq!(deposit(&mut c, DAVE, 52, 1), 0, "a top-up can be any size");
    assert_eq!(c.tender_deposit_of(0, id(DAVE)).0, dust + 1);
}

#[test]
fn a_full_tender_takes_no_more() {
    let mut c = open_tender(|_| 0);
    let max = c.get_tender(0).unwrap().max_deposit.0;
    assert_eq!(deposit(&mut c, DAVE, 50, max), 0);
    call(PEPE, OLD, 51, 0);
    assert_refused("the tender is full", || c.ft_on_transfer(id(CAROL), U128(OLD_SUPPLY / 10), "0".into()));
    assert_eq!(c.get_tender(0).unwrap().deposited.0, max);
}

#[test]
fn a_refund_the_token_refuses_stays_claimable() {
    let mut c = open_tender(|_| 0);
    let amount = bps_of(OLD_SUPPLY, 4000);
    deposit(&mut c, DAVE, 50, amount);
    assert!(!settle(&mut c, 100), "nobody backed it");
    call(PEPE, DAVE, 101, 0);
    drop(c.claim_tender(0));
    assert_eq!(c.tender_deposit_of(0, id(DAVE)).0, 0, "taken out while the transfer runs");
    call(PEPE, PEPE, 102, 0);
    assert_eq!(c.on_tender_refund(0, id(DAVE), U128(amount), Err(PromiseError::Failed)).0, 0);
    assert_eq!(c.tender_deposit_of(0, id(DAVE)).0, amount, "back on the books");
    call(PEPE, DAVE, 103, 0);
    drop(c.claim_tender(0));
    assert_eq!(calls_to(OLD, "ft_transfer")[0].0["amount"], amount.to_string());
    call(PEPE, PEPE, 104, 0);
    assert_eq!(c.on_tender_refund(0, id(DAVE), U128(amount), Ok(())).0, amount);
    call(PEPE, DAVE, 105, 0);
    assert_refused("nothing to claim", || c.claim_tender(0));
}

#[test]
fn only_depositors_claim_and_only_after_settlement() {
    let mut c = open_tender(|_| 0);
    back(&mut c, ALICE, 45);
    deposit(&mut c, DAVE, 50, bps_of(OLD_SUPPLY, 4000));
    call(PEPE, DAVE, 60, 0);
    assert_refused("the tender is not settled yet", || c.claim_tender(0));
    assert!(settle(&mut c, 100));
    call(PEPE, CAROL, 101, 0);
    assert_refused("nothing to claim", || c.claim_tender(0));
}

#[test]
fn a_token_that_reports_no_supply_fails_the_tender() {
    let mut c = pepe_for_tenders();
    let rate = top_tender_rate(&c, OLD_SUPPLY);
    for (tender_id, answer) in [(0, PromiseResult::Failed), (1, PromiseResult::Successful(b"\"lots\"".to_vec()))] {
        assert!(!tender_answered(&mut c, tender_id, rate, vec![registered(), answer]));
        assert_eq!(
            c.get_tender(tender_id).unwrap().status,
            TenderStatus::Failed { reason: "the token did not report a supply".into() }
        );
    }
    assert!(tender(&mut c, 2, rate, OLD_SUPPLY), "a failed tender frees the token for the next one");
}

#[test]
fn a_tender_opens_only_if_the_token_registers_the_coin() {
    let mut c = pepe_for_tenders();
    let rate = top_tender_rate(&c, OLD_SUPPLY);
    // Deposits to an unregistered coin would all bounce: the tender must not open.
    assert!(!tender_answered(&mut c, 0, rate, vec![PromiseResult::Failed, supply_answer(OLD_SUPPLY)]));
    assert_eq!(tender_failure(&c), "the token would not register this coin");
    assert!(tender(&mut c, 1, rate, OLD_SUPPLY), "the token is free for the next tender");
}

#[test]
fn a_stuck_tender_can_be_cancelled_after_ten_minutes() {
    let mut c = pepe_for_tenders();
    call(PEPE, ALICE, 40, 0);
    drop(c.propose_tender(id(OLD), U128(top_tender_rate(&c, OLD_SUPPLY)), "Swap your OLD.".into()));
    assert_eq!(c.get_tender(0).unwrap().status, TenderStatus::Opening);
    call(PEPE, CAROL, 40 + 600, 0);
    assert_refused("give it ten minutes", || c.cancel_stuck_tender(0));
    call(PEPE, CAROL, 40 + 601, 0);
    c.cancel_stuck_tender(0);
    assert_eq!(tender_failure(&c), "the token never answered");
    assert_refused("tender is not stuck", || c.cancel_stuck_tender(0));
}

#[test]
fn tenders_are_for_outside_tokens_one_at_a_time() {
    let mut c = open_tender(|_| 0);
    call(PEPE, ALICE, 41, 0);
    assert_refused("one open tender per token", || c.propose_tender(id(OLD), U128(1), "Again.".into()));
    assert_refused("is a launchpad coin: make a takeover bid instead", || {
        c.propose_tender(id(DOGE), U128(1), "x".into())
    });
    assert_refused("is a launchpad coin", || c.propose_tender(id(PEPE), U128(1), "x".into()));
    call(PEPE, BOB, 41, 0);
    assert_refused("lock more tokens", || c.propose_tender(id("new.testnet"), U128(1), "x".into()));
}

#[test]
fn the_watchlist_takes_up_to_eight_outside_tokens() {
    let mut c = pepe_for_tenders();
    call(PEPE, ALICE, 10, 0);
    assert_refused("siblings get takeover bids", || c.nominate(id(DOGE)));
    for i in 0..MAX_WATCHLIST {
        c.nominate(id(&format!("t{i}.testnet")));
    }
    assert_refused("the watchlist is full", || c.nominate(id("t9.testnet")));
    assert_refused("already on the watchlist", || c.nominate(id("t0.testnet")));
    c.denominate(id("t0.testnet"));
    assert_refused("not on the watchlist", || c.denominate(id("t0.testnet")));
    c.nominate(id("t9.testnet"));
    assert_eq!(c.watchlist.len(), MAX_WATCHLIST);
    call(PEPE, BOB, 11, 0);
    assert_refused("lock more tokens", || c.nominate(id("t10.testnet")));
}

// ---------- sealed votes ----------

/// The commitment for `who`'s vote: sha256 hex of "offer|round|account|support|salt".
fn seal(offer: &str, round: u32, who: &str, support: bool, salt: &str) -> String {
    crate::hex(&near_sdk::env::sha256(format!("{offer}|{round}|{who}|{support}|{salt}").as_bytes()))
}

/// DOGE with private voting (60 s sealed, then 30 s to reveal), where alice and
/// bob lock everything at second 10 and PEPE bids at 40. Votes end at 100,
/// reveals at 130.
fn sealed_bid() -> (Coin, String) {
    let mut c = doge();
    c.params.reveal_period_sec = 30;
    lock_all(&mut c, DOGE, ALICE, 10);
    lock_all(&mut c, DOGE, BOB, 10);
    let (key, _) = bid(&mut c, 40);
    (c, key)
}

/// The secret `who` seals with in these tests.
fn salt(who: &str) -> String {
    format!("{who}-salt")
}

/// `who` commits a round-0 vote at `sec`.
fn vote_sealed(c: &mut Coin, key: &str, who: &str, sec: u64, support: bool) -> u128 {
    call(DOGE, who, sec, 0);
    c.vote_sealed(key.into(), seal(key, 0, who, support, &salt(who))).0
}

fn reveal(c: &mut Coin, key: &str, who: &str, sec: u64, support: bool) -> u128 {
    call(DOGE, who, sec, 0);
    c.reveal_vote(key.into(), support, salt(who)).0
}

#[test]
fn a_sealed_vote_shows_its_weight_but_not_its_side_until_revealed() {
    let (mut c, key) = sealed_bid();
    let (a, b) = (c.locked_of(&id(ALICE)), c.locked_of(&id(BOB)));
    assert_eq!(vote_sealed(&mut c, &key, ALICE, 41, true), a);
    assert_eq!(vote_sealed(&mut c, &key, BOB, 42, false), b);
    let o = c.get_incoming(key.clone()).unwrap();
    assert_eq!((o.yes.0, o.no.0, o.sealed.0), (0, 0, a + b));
    assert_eq!(reveal(&mut c, &key, ALICE, 100, true), a);
    assert_eq!(reveal(&mut c, &key, BOB, 101, false), b);
    let o = c.get_incoming(key).unwrap();
    assert_eq!((o.yes.0, o.no.0, o.sealed.0), (a, b, 0));
}

#[test]
fn a_reveal_must_match_the_commitment() {
    let (mut c, key) = sealed_bid();
    vote_sealed(&mut c, &key, ALICE, 41, true);
    call(DOGE, ALICE, 100, 0);
    assert_refused("vote and salt do not match the commitment", || c.reveal_vote(key.clone(), false, salt(ALICE)));
    assert_refused("vote and salt do not match the commitment", || c.reveal_vote(key.clone(), true, salt(BOB)));
    call(DOGE, BOB, 100, 0);
    assert_refused("no sealed vote to reveal", || c.reveal_vote(key.clone(), true, salt(ALICE)));
    reveal(&mut c, &key, ALICE, 101, true);
    call(DOGE, ALICE, 102, 0);
    assert_refused("no sealed vote to reveal", || c.reveal_vote(key.clone(), true, salt(ALICE)));
}

#[test]
fn reveals_open_when_the_vote_ends_and_close_with_the_window() {
    let (mut c, key) = sealed_bid();
    vote_sealed(&mut c, &key, ALICE, 41, true);
    vote_sealed(&mut c, &key, BOB, 42, false);
    call(DOGE, ALICE, 99, 0);
    assert_refused("the vote is still running: reveal after it ends", || c.reveal_vote(key.clone(), true, salt(ALICE)));
    reveal(&mut c, &key, ALICE, 129, true);
    call(DOGE, BOB, 130, 0);
    assert_refused("the reveal window is closed", || c.reveal_vote(key.clone(), false, salt(BOB)));
}

#[test]
fn the_vote_cannot_close_while_votes_are_being_revealed() {
    let (mut c, key) = sealed_bid();
    vote_sealed(&mut c, &key, ALICE, 41, true);
    reveal(&mut c, &key, ALICE, 100, true);
    call(DOGE, CAROL, 129, 0);
    assert_refused("sealed votes are still being revealed", || c.finalize(key.clone()));
    call(DOGE, CAROL, 130, 0);
    assert!(closed(c.finalize(key)));
}

#[test]
fn an_unrevealed_vote_counts_for_nothing() {
    let (mut c, key) = sealed_bid();
    let a = vote_sealed(&mut c, &key, ALICE, 41, true);
    assert!(a > bps_of(c.circulating(), 1000), "alice alone would make the quorum");
    // alice never reveals: her YES counts neither for the deal nor toward the quorum.
    call(DOGE, CAROL, 130, 0);
    assert!(!closed(c.finalize(key.clone())));
    assert_eq!(failure(&c, &key), "quorum not reached");
}

#[test]
fn an_open_vote_is_refused_where_votes_are_sealed() {
    let (mut c, key) = sealed_bid();
    call(DOGE, ALICE, 41, 0);
    assert_refused("votes are sealed here: use vote_sealed, then reveal_vote", || c.vote(key.clone(), true));
}

#[test]
fn a_sealed_vote_is_refused_where_votes_are_open() {
    let mut c = doge();
    lock_all(&mut c, DOGE, ALICE, 10);
    let (key, _) = bid(&mut c, 40);
    call(DOGE, ALICE, 41, 0);
    let commitment = seal(&key, 0, ALICE, true, "s");
    assert_refused("votes are open here: use vote", || c.vote_sealed(key.clone(), commitment));
}

#[test]
fn a_commitment_must_be_a_sha256_in_hex() {
    let (mut c, key) = sealed_bid();
    let good = seal(&key, 0, ALICE, true, &salt(ALICE));
    call(DOGE, ALICE, 41, 0);
    assert_refused("commitment must be a sha256 in hex", || c.vote_sealed(key.clone(), good[1..].to_string()));
    assert_refused("commitment must be a sha256 in hex", || c.vote_sealed(key.clone(), format!("g{}", &good[1..])));
    // Upper-case hex is the same hash: it is stored lower-case and reveals.
    c.vote_sealed(key.clone(), good.to_uppercase());
    assert_eq!(reveal(&mut c, &key, ALICE, 100, true), c.locked_of(&id(ALICE)));
}

#[test]
fn a_sealed_vote_keeps_the_tokens_locked_through_the_reveal_window() {
    let (mut c, key) = sealed_bid();
    let a = c.locked_of(&id(ALICE));
    vote_sealed(&mut c, &key, ALICE, 41, true);
    call(DOGE, ALICE, 129, 0);
    assert_refused("these tokens back a vote that has not ended", || c.unlock(U128(a)));
    call(DOGE, ALICE, 130, 0);
    c.unlock(U128(a));
    assert_eq!(balance(&c, ALICE), a);
}

#[test]
fn a_lock_made_after_the_bid_cannot_cast_a_sealed_vote() {
    let (mut c, key) = sealed_bid();
    buy(&mut c, DOGE, CAROL, 41, NEAR);
    lock_all(&mut c, DOGE, CAROL, 42);
    call(DOGE, CAROL, 43, 0);
    let commitment = seal(&key, 0, CAROL, false, "s");
    assert_refused("no tokens locked before this offer was announced", || c.vote_sealed(key.clone(), commitment));
}

#[test]
fn a_holder_casts_one_sealed_vote_per_round() {
    let (mut c, key) = sealed_bid();
    let a = vote_sealed(&mut c, &key, ALICE, 41, true);
    call(DOGE, ALICE, 42, 0);
    let other = seal(&key, 0, ALICE, false, "other-salt");
    assert_refused("already voted in this round", || c.vote_sealed(key.clone(), other));
    assert_eq!(c.get_incoming(key).unwrap().sealed.0, a);
}

#[test]
fn an_accepted_counter_voids_the_sealed_votes_of_the_old_round() {
    let (mut c, key) = sealed_bid();
    vote_sealed(&mut c, &key, ALICE, 41, true);
    let rate = c.get_incoming(key.clone()).unwrap().rate_ppm.0;
    call(DOGE, ALICE, 55, 0);
    drop(
        c.try_counter(key.clone(), rate * 12 / 11, "Pay more.".into(), Proposer::Holder { account_id: id(ALICE) })
            .unwrap(),
    );
    call(DOGE, PEPE, 70, 0);
    assert_eq!(c.apply_counter(0, U128(rate * 12 / 11)).round, 1);
    assert_eq!(c.get_incoming(key.clone()).unwrap().sealed.0, 0, "round 0 ballots no longer count");
    // Round 1 runs to 130 and reveals to 160. bob seals in it; alice does not.
    call(DOGE, BOB, 71, 0);
    let b = c.vote_sealed(key.clone(), seal(&key, 1, BOB, false, &salt(BOB))).0;
    call(DOGE, ALICE, 130, 0);
    assert_refused("no sealed vote to reveal", || c.reveal_vote(key.clone(), true, salt(ALICE)));
    assert_eq!(reveal(&mut c, &key, BOB, 131, false), b);
    let o = c.get_incoming(key).unwrap();
    assert_eq!((o.yes.0, o.no.0, o.sealed.0), (0, b, 0), "alice's round-0 YES never counts");
}

// ---------- the curve ----------

#[test]
fn a_round_trip_pays_the_trading_fee_both_ways() {
    let mut c = launch(DOGE);
    call(DOGE, ALICE, 1, 10 * NEAR);
    let storage = c.token.account_storage_usage as u128 * near_sdk::env::storage_byte_cost().as_yoctonear();
    let net = 10 * NEAR - storage;
    let got = c.buy(None).0;
    assert_eq!(
        got,
        crate::math::amm_out(VIRTUAL, SUPPLY, net - bps_of(net, 100)),
        "1% of the buy stays out of the curve"
    );
    let gross = crate::math::amm_out(c.amm_tokens, c.amm_near, got);
    assert_eq!(c.quote_sell(U128(got)).0, gross - bps_of(gross, 100));
    call(DOGE, ALICE, 2, 1);
    assert_eq!(c.sell(U128(got), None).0, gross - bps_of(gross, 100), "and 1% of the sale");
    assert_eq!(c.amm_tokens, SUPPLY);
    assert!(c.amm_near >= VIRTUAL, "rounding stays in the curve");
    assert_eq!(calls_to_transfer(ALICE), gross - bps_of(gross, 100));
}

/// NEAR the last call sent to `to` as a plain transfer.
fn calls_to_transfer(to: &str) -> u128 {
    get_created_receipts()
        .into_iter()
        .filter(|r| r.receiver_id == id(to))
        .flat_map(|r| r.actions)
        .map(|a| match a {
            MockAction::Transfer { deposit, .. } => deposit.as_yoctonear(),
            _ => 0,
        })
        .sum()
}

// ---------- random runs against the rules ----------

/// Random buys, sells, locks, unlocks and transfers. After every step:
/// every token is in a balance, a lock or the curve; the curve's NEAR is
/// always covered by what buyers paid in, minus what sellers took out; and
/// the curve's product never shrinks. At the end everyone sells out.
#[test]
fn random_trading_keeps_every_token_and_every_yocto_accounted_for() {
    let holders = [ALICE, BOB, CAROL, DAVE];
    for seed in 1..=8 {
        let mut rng = Rng(seed);
        let mut c = launch(DOGE);
        let (mut paid_in, mut paid_out) = (0u128, 0u128);
        let mut k = U256::from(c.amm_near) * U256::from(c.amm_tokens);
        let mut sec = 0;
        for step in 0..500 {
            sec += 1 + rng.below(3);
            let who = holders[rng.below(4) as usize];
            let free = balance(&c, who);
            let locked = c.locked_of(&id(who));
            match rng.below(5) {
                0 => {
                    let near = NEAR / 100 * (1 + rng.below(300) as u128);
                    paid_in += near;
                    buy(&mut c, DOGE, who, sec, near);
                }
                1 if free > 0 => {
                    call(DOGE, who, sec, 1);
                    paid_out += c.sell(U128((free / (1 + rng.below(3) as u128)).max(1)), None).0;
                }
                2 if free > 0 => lock(&mut c, DOGE, who, sec, (free / (1 + rng.below(3) as u128)).max(1)),
                3 if locked > 0 => {
                    call(DOGE, who, sec, 0);
                    c.unlock(U128((locked / (1 + rng.below(3) as u128)).max(1)));
                }
                4 if free > 0 => {
                    let to = holders[rng.below(4) as usize];
                    if to != who && c.token.accounts.contains_key(&id(to)) {
                        call(DOGE, who, sec, 1);
                        c.ft_transfer(id(to), U128((free / 2).max(1)), None);
                    }
                }
                _ => {}
            }
            let step = format!("seed {seed} step {step}");
            assert_eq!(balance(&c, DOGE), c.amm_tokens + c.total_locked, "{step}: curve + locks");
            let held: u128 = holders.iter().map(|h| balance(&c, h)).sum();
            assert_eq!(held + balance(&c, DOGE), SUPPLY, "{step}: tokens created or lost");
            assert_eq!(c.token.total_supply, SUPPLY, "{step}");
            assert_eq!(holders.iter().map(|h| c.locked_of(&id(h))).sum::<u128>(), c.total_locked, "{step}");
            for h in holders {
                assert_eq!(c.weight_at(&id(h), at(sec) + 1), c.locked_of(&id(h)), "{step}: weight");
            }
            assert!(paid_in >= paid_out + (c.amm_near - VIRTUAL), "{step}: the curve is not backed");
            let k2 = U256::from(c.amm_near) * U256::from(c.amm_tokens);
            assert!(k2 >= k, "{step}: the curve lost value");
            k = k2;
        }
        // Everyone unlocks and sells out: the curve can pay them all.
        for who in holders {
            sec += 1;
            let locked = c.locked_of(&id(who));
            if locked > 0 {
                call(DOGE, who, sec, 0);
                c.unlock(U128(locked));
            }
            let free = balance(&c, who);
            if free > 0 {
                call(DOGE, who, sec, 1);
                paid_out += c.sell(U128(free), None).0;
            }
        }
        assert_eq!(c.amm_tokens, SUPPLY, "seed {seed}: every token is back in the curve");
        assert!(c.amm_near >= VIRTUAL && paid_out <= paid_in, "seed {seed}");
    }
}

/// Holders lock at random times around a bid and vote at random. The coin's
/// count must match a count made here by hand: only lots locked strictly
/// before the bid, each holder once, quorum and approval on the supply at the bid.
#[test]
fn random_votes_match_a_count_made_by_hand() {
    let holders = [ALICE, BOB, CAROL, DAVE, "erin.testnet", "frank.testnet"];
    let (mut passes, mut fails, mut late_refused) = (0, 0, 0);
    for seed in 0..200u64 {
        let mut rng = Rng(seed * 7919 + 1);
        let mut c = launch(DOGE);
        for h in holders {
            buy(&mut c, DOGE, h, 1, NEAR / 10 * (1 + rng.below(40) as u128));
        }
        let bid_sec = 31 + rng.below(30);
        // Up to three lots each, from second 2 to 20 s after the bid, in time order.
        let mut locks: Vec<(u64, &str)> = vec![];
        for h in holders {
            for _ in 0..rng.below(4) {
                locks.push((2 + rng.below(bid_sec + 19), h));
            }
        }
        locks.sort();
        let mut early = std::collections::HashMap::<&str, u128>::new();
        let mut bid_done = false;
        let mut key = String::new();
        for (sec, h) in locks.iter().copied().chain([(bid_sec + 30, "")]) {
            if !bid_done && sec >= bid_sec {
                key = bid(&mut c, bid_sec).0;
                bid_done = true;
            }
            if h.is_empty() {
                continue;
            }
            let amount = balance(&c, h) / (1 + rng.below(3) as u128);
            if amount == 0 {
                continue;
            }
            lock(&mut c, DOGE, h, sec, amount);
            if sec < bid_sec {
                *early.entry(h).or_default() += amount;
            }
        }
        let circulating: u128 = holders.iter().map(|h| balance(&c, h) + c.locked_of(&id(h))).sum();
        let (mut yes, mut no) = (0u128, 0u128);
        for h in holders {
            if rng.below(5) == 0 {
                continue; // abstains
            }
            let support = rng.below(10) < 7;
            call(DOGE, h, bid_sec + 31 + rng.below(28), 0);
            let weight = early.get(h).copied().unwrap_or(0);
            if weight == 0 {
                assert!(refused(|| c.vote(key.clone(), support)), "seed {seed}: {h} had nothing locked before the bid");
                late_refused += 1;
                continue;
            }
            assert_eq!(c.vote(key.clone(), support).0, weight, "seed {seed}: {h}'s weight");
            assert!(refused(|| c.vote(key.clone(), !support)), "seed {seed}: {h} voted twice");
            if support { yes += weight } else { no += weight }
        }
        let o = c.get_incoming(key.clone()).unwrap();
        assert_eq!((o.yes.0, o.no.0), (yes, no), "seed {seed}: tally");
        let turnout = yes + no;
        let expected = turnout > 0 && turnout >= circulating / 10 && yes >= turnout * 67 / 100;
        call(DOGE, CAROL, bid_sec + 60, 0);
        assert_eq!(closed(c.finalize(key)), expected, "seed {seed}: outcome");
        if expected { passes += 1 } else { fails += 1 }
    }
    assert!(
        passes > 20 && fails > 20 && late_refused > 20,
        "{passes} passed, {fails} failed, {late_refused} late votes refused"
    );
}

/// Holders of an absorbed coin convert in random pieces. Minted tokens
/// plus what is still owed never exceed the deal's cap, the supply grows by
/// exactly what was minted, and the last token past the cap is refused.
#[test]
fn random_conversions_never_mint_past_the_cap() {
    for seed in 1..=50u64 {
        let mut rng = Rng(seed);
        let (mut c, _, rate) = pepe_bids(|_| 0);
        let circ = doge_market().circulating.0 / (1 + rng.below(4) as u128) + rng.below(1_000_000) as u128;
        assert!(execute(&mut c, 101, circ, doge_market()));
        let cap = mul_div(circ, rate, RATE_SCALE);
        let supply = c.token.total_supply;
        let (mut converted, mut minted) = (0u128, 0u128);
        let mut sec = 102;
        while converted < circ {
            let piece = ((circ / (1 + rng.below(8) as u128)) + rng.below(1000) as u128).min(circ - converted).max(1);
            call(PEPE, DOGE, sec, 0);
            minted += c.mint_converted(id(BOB), U128(piece)).0;
            converted += piece;
            sec += 1;
            assert!(minted + c.owed() <= cap, "seed {seed}: minted past the cap");
            assert_eq!(c.token.total_supply, supply + minted, "seed {seed}");
        }
        assert_eq!(c.owed(), 0);
        call(PEPE, DOGE, sec, 0);
        assert!(refused(|| c.mint_converted(id(BOB), U128(1))), "seed {seed}");
    }
}
