//! Offers, counters, votes, vetoes, merges and conversions.
//!
//! Buyer side: try_make_offer -> (target) receive_offer -> on_offer_sent
//! Target side: vote ... finalize -> (buyer) execute_takeover -> on_execute
//! After a merge: (target) convert -> (buyer) mint_converted -> on_converted

use near_contract_standards::fungible_token::events::{FtBurn, FtMint};
use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::{
    AccountId, Gas, NearToken, Promise, PromiseError, PromiseOrValue, assert_one_yocto, env, near,
    require,
};

use crate::market::fmt_tokens;
use crate::math::{bps_of, fair_rate_ppm, mul_div, premium_bps};
use crate::types::*;
use crate::{Coin, CoinExt, truncate};

const GAS_RECEIVE_OFFER: Gas = Gas::from_tgas(20);
const GAS_ON_OFFER_SENT: Gas = Gas::from_tgas(15);
const GAS_NOTIFY: Gas = Gas::from_tgas(10);
const GAS_APPLY_COUNTER: Gas = Gas::from_tgas(15);
const GAS_ON_COUNTER_APPLIED: Gas = Gas::from_tgas(10);
const GAS_EXECUTE: Gas = Gas::from_tgas(20);
const GAS_ON_EXECUTE: Gas = Gas::from_tgas(40);
const GAS_ABSORB: Gas = Gas::from_tgas(10);
const GAS_MINT: Gas = Gas::from_tgas(15);
const GAS_ON_CONVERTED: Gas = Gas::from_tgas(10);

#[near]
impl Coin {
    // ---------- manual proposals (the brain uses the same internals) ----------

    /// Bid for a sibling coin by hand. Needs `proposer_bps` of supply locked.
    pub fn propose_offer(&mut self, target: AccountId, rate_ppm: U128, pitch: String) -> Promise {
        let who = self.assert_proposer(self.params.vote_period_sec);
        self.try_make_offer(target, rate_ppm.0, pitch, Proposer::Holder { account_id: who })
            .unwrap_or_else(|e| env::panic_str(&e))
    }

    /// Counter a bid we received, by hand.
    pub fn propose_counter(&mut self, offer: String, rate_ppm: U128, pitch: String) -> Promise {
        let who = self.assert_proposer(self.params.vote_period_sec);
        self.try_counter(offer, rate_ppm.0, pitch, Proposer::Holder { account_id: who })
            .unwrap_or_else(|e| env::panic_str(&e))
    }

    /// Accept the target's counter to one of our bids, by hand.
    pub fn accept_counter(&mut self, offer_id: u64) -> Promise {
        self.assert_proposer(self.params.vote_period_sec);
        self.try_accept_counter(offer_id).unwrap_or_else(|e| env::panic_str(&e))
    }

    // ---------- target side ----------

    /// Called by a sibling coin that bids for us. Checks every cap against our
    /// own market numbers and opens the vote.
    pub fn receive_offer(
        &mut self,
        id: u64,
        rate_ppm: U128,
        pitch: String,
        proposer: Proposer,
        buyer_market: MarketSnapshot,
    ) -> OfferAck {
        let buyer = env::predecessor_account_id();
        let now = self.now();
        require!(self.is_sibling(&buyer), "only coins from the same launchpad can bid");
        self.assert_active();
        require!(now >= self.protected_until(), "newborn protection: too young to be bought");
        if let Some(t) = self.last_failed.get(&buyer) {
            require!(
                now >= t + self.params.rebid_cooldown_sec * NS_PER_SEC,
                "cooldown: this buyer failed recently"
            );
        }
        require!(!self.in_by_buyer.contains_key(&buyer), "one open offer per pair");
        require!(!self.out_by_target.contains_key(&buyer), "one open offer per pair");

        let target_market = self.market();
        let (fair, premium) = self.check_terms(rate_ppm.0, &buyer_market, &target_market);

        let offer = Offer {
            buyer: buyer.clone(),
            target: self.me(),
            id,
            rate_ppm,
            fair_rate_ppm: U128(fair),
            premium_bps: premium,
            pitch: truncate(pitch, MAX_PITCH_LEN),
            proposer,
            created_at: now,
            vote_ends: now + self.params.vote_period_sec * NS_PER_SEC,
            round: 0,
            counter: None,
            yes: U128(0),
            no: U128(0),
            sealed: U128(0),
            veto: U128(0),
            buyer_market,
            target_market: target_market.clone(),
            status: OfferStatus::Open,
        };
        let key = offer.key();
        self.in_by_buyer.insert(buyer.clone(), key.clone());
        let text = format!(
            "{buyer} bids {} per token ({premium:+} bps vs fair): \"{}\"",
            fmt_rate(rate_ppm.0),
            offer.pitch
        );
        self.emit(
            "offer_received",
            json!({ "offer": key, "buyer": buyer, "rate_ppm": rate_ppm, "premium_bps": premium, "vote_ends": offer.vote_ends }),
            text,
        );
        let ack = OfferAck {
            created_at: offer.created_at,
            vote_ends: offer.vote_ends,
            fair_rate_ppm: offer.fair_rate_ppm,
            premium_bps: premium,
            target_market,
        };
        self.incoming.insert(key, offer);
        ack
    }

    /// Vote on a bid for this coin, with tokens locked before it was announced.
    pub fn vote(&mut self, offer: String, support: bool) -> U128 {
        let who = env::predecessor_account_id();
        let now = self.now();
        let o = self.incoming.get(&offer).cloned().expect("unknown offer");
        require!(o.status == OfferStatus::Open && now < o.vote_ends, "voting is closed");
        require!(self.params.reveal_period_sec == 0, "votes are sealed here: use vote_sealed, then reveal_vote");
        let weight = self.weight_at(&who, o.created_at);
        require!(weight > 0, "no tokens locked before this offer was announced");
        let ballot = format!("in|{offer}|{}|{who}", o.round);
        require!(self.voted.insert(ballot), "already voted in this round");
        let o = self.incoming.get_mut(&offer).unwrap();
        if support {
            o.yes = U128(o.yes.0 + weight);
        } else {
            o.no = U128(o.no.0 + weight);
        }
        let vote_ends = o.vote_ends;
        let (yes, no) = (o.yes, o.no);
        self.extend_vote_lock(&who, vote_ends);
        let text = format!(
            "{who} voted {} on {offer} with {}",
            if support { "YES" } else { "NO" },
            fmt_tokens(weight)
        );
        self.emit(
            "vote",
            json!({ "offer": offer, "account": who, "support": support, "weight": U128(weight), "yes": yes, "no": no }),
            text,
        );
        U128(weight)
    }

    /// Private voting, step 1: commit a vote without showing its direction.
    /// `commitment` is the sha256 (hex) of "offer|round|account|true|salt" for
    /// YES or "...|false|salt" for NO, with a secret salt of your choice.
    pub fn vote_sealed(&mut self, offer: String, commitment: String) -> U128 {
        let who = env::predecessor_account_id();
        let now = self.now();
        let o = self.incoming.get(&offer).cloned().expect("unknown offer");
        require!(o.status == OfferStatus::Open && now < o.vote_ends, "voting is closed");
        require!(self.params.reveal_period_sec > 0, "votes are open here: use vote");
        require!(
            commitment.len() == 64 && commitment.bytes().all(|b| b.is_ascii_hexdigit()),
            "commitment must be a sha256 in hex"
        );
        let weight = self.weight_at(&who, o.created_at);
        require!(weight > 0, "no tokens locked before this offer was announced");
        let key = format!("{offer}|{}|{who}", o.round);
        require!(self.voted.insert(format!("in|{key}")), "already voted in this round");
        self.sealed_ballots.insert(key, SealedBallot { commitment: commitment.to_lowercase(), weight: U128(weight) });
        let o = self.incoming.get_mut(&offer).unwrap();
        o.sealed = U128(o.sealed.0 + weight);
        let (sealed, reveal_ends) = (o.sealed, o.vote_ends + self.params.reveal_period_sec * NS_PER_SEC);
        self.extend_vote_lock(&who, reveal_ends);
        let text = format!("{who} cast a sealed vote on {offer} with {}", fmt_tokens(weight));
        self.emit("vote_sealed", json!({ "offer": offer, "account": who, "weight": U128(weight), "sealed": sealed }), text);
        U128(weight)
    }

    /// Private voting, step 2: after the vote period, show the vote. A vote
    /// that is not revealed in the reveal window does not count.
    pub fn reveal_vote(&mut self, offer: String, support: bool, salt: String) -> U128 {
        let who = env::predecessor_account_id();
        let now = self.now();
        let o = self.incoming.get(&offer).cloned().expect("unknown offer");
        let reveal_ends = o.vote_ends + self.params.reveal_period_sec * NS_PER_SEC;
        require!(o.status == OfferStatus::Open, "offer is not open");
        require!(now >= o.vote_ends, "the vote is still running: reveal after it ends");
        require!(now < reveal_ends, "the reveal window is closed");
        let key = format!("{offer}|{}|{who}", o.round);
        let ballot = self.sealed_ballots.get(&key).cloned().expect("no sealed vote to reveal");
        let opened = crate::hex(&env::sha256(format!("{key}|{support}|{salt}").as_bytes()));
        require!(opened == ballot.commitment, "vote and salt do not match the commitment");
        self.sealed_ballots.remove(&key);
        let weight = ballot.weight.0;
        let o = self.incoming.get_mut(&offer).unwrap();
        o.sealed = U128(o.sealed.0 - weight);
        if support {
            o.yes = U128(o.yes.0 + weight);
        } else {
            o.no = U128(o.no.0 + weight);
        }
        let (yes, no) = (o.yes, o.no);
        let text = format!(
            "{who} revealed a {} vote on {offer} with {}",
            if support { "YES" } else { "NO" },
            fmt_tokens(weight)
        );
        self.emit(
            "vote",
            json!({ "offer": offer, "account": who, "support": support, "weight": U128(weight), "yes": yes, "no": no }),
            text,
        );
        U128(weight)
    }

    /// Close the vote. Anyone can call this once the vote period (and the
    /// reveal window, with private voting) is over.
    pub fn finalize(&mut self, offer: String) -> PromiseOrValue<bool> {
        let now = self.now();
        let o = self.incoming.get(&offer).cloned().expect("unknown offer");
        require!(o.status == OfferStatus::Open, "offer is not open");
        match &self.status {
            CoinStatus::MergePending { .. } => {
                env::panic_str("another takeover is executing; try again shortly")
            }
            CoinStatus::Merged { .. } => {
                self.fail_incoming(&offer, "target already merged into another coin");
                return PromiseOrValue::Value(false);
            }
            CoinStatus::Active => {}
        }
        require!(now >= o.vote_ends, "the vote is still running");
        require!(
            now >= o.vote_ends + self.params.reveal_period_sec * NS_PER_SEC,
            "sealed votes are still being revealed"
        );

        let turnout = o.yes.0 + o.no.0;
        let quorum = bps_of(o.target_market.circulating.0, self.params.quorum_bps);
        if turnout == 0 || turnout < quorum {
            self.fail_incoming(&offer, "quorum not reached");
            return PromiseOrValue::Value(false);
        }
        if o.yes.0 < bps_of(turnout, self.params.approval_bps) {
            self.fail_incoming(&offer, "rejected by holders");
            return PromiseOrValue::Value(false);
        }

        // Passed: freeze trading and offers while the buyer executes.
        self.status = CoinStatus::MergePending { into: o.buyer.clone() };
        self.incoming.get_mut(&offer).unwrap().status = OfferStatus::Executing;
        let text = format!("holders approved {offer}; asking {} to execute", o.buyer);
        self.emit(
            "offer_passed",
            json!({ "offer": offer, "yes": o.yes, "no": o.no }),
            text,
        );
        // Holders of coins we absorbed but who have not converted yet will
        // convert into us and then on into the buyer: the cap must cover them.
        let claims = U128(self.circulating() + self.owed());
        PromiseOrValue::Promise(
            Self::ext(o.buyer.clone())
                .with_static_gas(GAS_EXECUTE)
                .execute_takeover(o.id, claims, self.market())
                .then(Self::ext(self.me()).with_static_gas(GAS_ON_EXECUTE).on_execute(offer)),
        )
    }

    #[private]
    pub fn on_execute(
        &mut self,
        offer: String,
        #[callback_result] executed: Result<bool, PromiseError>,
    ) -> bool {
        let o = self.incoming.get(&offer).cloned().expect("unknown offer");
        if executed != Ok(true) {
            self.status = CoinStatus::Active;
            self.fail_incoming(&offer, "the buyer vetoed or could not execute");
            return false;
        }

        let buyer = o.buyer.clone();
        let now = self.now();
        // The curve closes; its real NEAR and the treasury move to the buyer.
        // (Treasury first: it is computed net of the curve's real NEAR.)
        let curve_real = self.amm_near - self.params.virtual_near.0;
        let treasury = self.treasury();
        self.amm_near = self.params.virtual_near.0;
        self.status = CoinStatus::Merged { into: buyer.clone(), rate_ppm: o.rate_ppm, at: now };
        self.incoming.get_mut(&offer).unwrap().status = OfferStatus::Executed;
        self.in_by_buyer.remove(&buyer);
        let text = format!(
            "MERGED into {buyer} at {} per token; holders can now convert",
            fmt_rate(o.rate_ppm.0)
        );
        self.emit(
            "merged",
            json!({ "into": buyer, "rate_ppm": o.rate_ppm, "curve_near": U128(curve_real), "treasury": U128(treasury) }),
            text,
        );
        let total = curve_real + treasury;
        if total > 0 {
            Self::ext(buyer)
                .with_attached_deposit(NearToken::from_yoctonear(total))
                .with_static_gas(GAS_ABSORB)
                .absorb(U128(curve_real), U128(treasury))
                .detach();
        }
        true
    }

    /// Counter a bid. The new rate goes to the buyer; if the buyer accepts,
    /// the vote restarts on the new terms (same snapshot time).
    pub(crate) fn try_counter(
        &mut self,
        offer: String,
        rate_ppm: u128,
        pitch: String,
        by: Proposer,
    ) -> Result<Promise, String> {
        if self.status != CoinStatus::Active {
            return Err("this coin is not active".into());
        }
        let o = self.incoming.get(&offer).cloned().ok_or("unknown offer")?;
        if o.status != OfferStatus::Open || self.now() >= o.vote_ends {
            return Err("offer is not open".into());
        }
        let premium = premium_bps(rate_ppm, o.fair_rate_ppm.0);
        self.check_caps(rate_ppm, premium, &o.buyer_market, &self.market())?;
        let pitch = truncate(pitch, MAX_PITCH_LEN);
        let counter = Counter { rate_ppm: U128(rate_ppm), pitch: pitch.clone(), by: by.clone(), at: self.now() };
        self.incoming.get_mut(&offer).unwrap().counter = Some(counter);
        let text = format!("counter to {offer}: {} per token: \"{pitch}\"", fmt_rate(rate_ppm));
        self.emit(
            "counter",
            json!({ "offer": offer, "rate_ppm": U128(rate_ppm), "premium_bps": premium }),
            text,
        );
        Ok(Self::ext(o.buyer)
            .with_static_gas(GAS_NOTIFY)
            .receive_counter(o.id, U128(rate_ppm), pitch, by))
    }

    /// The buyer accepted our counter: switch terms, restart the vote.
    pub fn apply_counter(&mut self, id: u64) -> CounterAck {
        let buyer = env::predecessor_account_id();
        let key = offer_key(&buyer, id);
        let now = self.now();
        let period = self.params.vote_period_sec * NS_PER_SEC;
        let o = self.incoming.get_mut(&key).expect("unknown offer");
        require!(o.status == OfferStatus::Open && now < o.vote_ends, "offer is not open");
        let counter = o.counter.take().expect("no counter to accept");
        o.rate_ppm = counter.rate_ppm;
        o.premium_bps = premium_bps(counter.rate_ppm.0, o.fair_rate_ppm.0);
        o.round += 1;
        o.yes = U128(0);
        o.no = U128(0);
        o.sealed = U128(0);
        o.vote_ends = now + period;
        let ack = CounterAck {
            rate_ppm: o.rate_ppm,
            premium_bps: o.premium_bps,
            vote_ends: o.vote_ends,
            round: o.round,
        };
        let text = format!(
            "{buyer} accepted the counter on {key}: new rate {}, vote restarts",
            fmt_rate(ack.rate_ppm.0)
        );
        self.emit(
            "counter_accepted",
            json!({ "offer": key, "rate_ppm": ack.rate_ppm, "round": ack.round, "vote_ends": ack.vote_ends }),
            text,
        );
        ack
    }

    /// After a merge: swap your whole balance (locked included) into the buyer.
    #[payable]
    pub fn convert(&mut self) -> Promise {
        assert_one_yocto();
        let CoinStatus::Merged { into, .. } = self.status.clone() else {
            env::panic_str("this coin has not merged");
        };
        let who = env::predecessor_account_id();
        let free = self.token.accounts.get(&who).unwrap_or(0);
        let locked = self.locked_of(&who);
        let total = free + locked;
        require!(total > 0, "nothing to convert");
        if locked > 0 {
            self.locks.remove(&who);
            self.total_locked -= locked;
            let me = self.me();
            self.token.internal_withdraw(&me, locked);
        }
        if free > 0 {
            self.token.internal_withdraw(&who, free);
        }
        let memo = format!("converted into {into}");
        FtBurn { owner_id: &who, amount: U128(total), memo: Some(&memo) }.emit();
        let text = format!("{who} converted {} into {into}", fmt_tokens(total));
        self.emit("convert", json!({ "account": who, "amount": U128(total), "into": into }), text);
        Self::ext(into)
            .with_static_gas(GAS_MINT)
            .mint_converted(who.clone(), U128(total))
            .then(
                Self::ext(self.me())
                    .with_static_gas(GAS_ON_CONVERTED)
                    .on_converted(who, U128(total)),
            )
    }

    #[private]
    pub fn on_converted(
        &mut self,
        account_id: AccountId,
        amount: U128,
        #[callback_result] minted: Result<U128, PromiseError>,
    ) -> U128 {
        if let Ok(out) = minted {
            return out;
        }
        // The buyer refused: give the tokens back.
        self.ensure_registered(&account_id);
        self.token.internal_deposit(&account_id, amount.0);
        FtMint { owner_id: &account_id, amount, memo: Some("conversion refunded") }.emit();
        U128(0)
    }

    // ---------- buyer side ----------

    /// The target accepted our bid for voting (or refused it).
    #[private]
    pub fn on_offer_sent(
        &mut self,
        id: u64,
        #[callback_result] ack: Result<OfferAck, PromiseError>,
    ) -> bool {
        let Some(o) = self.outgoing.get(&id).cloned() else { return false };
        match ack {
            Ok(a) => {
                let o2 = self.outgoing.get_mut(&id).unwrap();
                o2.status = OfferStatus::Open;
                o2.created_at = a.created_at;
                o2.vote_ends = a.vote_ends;
                o2.fair_rate_ppm = a.fair_rate_ppm;
                o2.premium_bps = a.premium_bps;
                o2.target_market = a.target_market;
                let text = format!(
                    "we bid for {} at {} per token ({:+} bps vs fair): \"{}\"",
                    o.target,
                    fmt_rate(o.rate_ppm.0),
                    a.premium_bps,
                    o.pitch
                );
                self.emit(
                    "offer_made",
                    json!({ "offer": o.key(), "target": o.target, "rate_ppm": o.rate_ppm, "premium_bps": a.premium_bps }),
                    text,
                );
                true
            }
            Err(_) => {
                self.fail_outgoing(id, "the target refused the bid (see its logs)");
                false
            }
        }
    }

    /// Veto a deal our own coin made, with tokens locked before it was announced.
    pub fn veto(&mut self, offer_id: u64) -> U128 {
        let who = env::predecessor_account_id();
        let o = self.outgoing.get(&offer_id).cloned().expect("unknown offer");
        require!(o.status == OfferStatus::Open && self.now() < o.vote_ends, "veto window is closed");
        let weight = self.weight_at(&who, o.created_at);
        require!(weight > 0, "no tokens locked before this offer was announced");
        let ballot = format!("out|{offer_id}|{}|{who}", o.round);
        require!(self.voted.insert(ballot), "already vetoed in this round");
        let o2 = self.outgoing.get_mut(&offer_id).unwrap();
        o2.veto = U128(o2.veto.0 + weight);
        let (veto, ends) = (o2.veto, o2.vote_ends);
        self.extend_vote_lock(&who, ends);
        let text = format!("{who} vetoed our bid for {} with {}", o.target, fmt_tokens(weight));
        self.emit(
            "veto",
            json!({ "offer": o.key(), "account": who, "weight": U128(weight), "veto": veto }),
            text,
        );
        U128(weight)
    }

    /// The target's holders approved. Last checks on our side: veto and dilution.
    pub fn execute_takeover(&mut self, id: u64, target_circulating: U128, target_market: MarketSnapshot) -> bool {
        let target = env::predecessor_account_id();
        let o = self.outgoing.get(&id).cloned().expect("unknown offer");
        require!(o.target == target, "not your offer");
        require!(o.status == OfferStatus::Open, "offer is not open");
        if self.status != CoinStatus::Active {
            self.fail_outgoing(id, "buyer is no longer active");
            return false;
        }
        // The smaller of the supply at the bid and now: inflating supply
        // around the bid cannot raise the veto line.
        let veto_base = o.buyer_market.circulating.0.min(self.circulating());
        if o.veto.0 > 0 && o.veto.0 >= bps_of(veto_base, self.params.veto_bps) {
            self.fail_outgoing(id, "vetoed by our holders");
            return false;
        }
        // Prices now, not at the bid: a target pumped for the bid and dumped
        // after it no longer fits under the premium cap.
        let fair_now = fair_rate_ppm(
            target_market.amm_near.0,
            target_market.amm_tokens.0,
            self.amm_near,
            self.amm_tokens,
        );
        if premium_bps(o.rate_ppm.0, fair_now) > self.params.max_premium_bps as i64 {
            self.fail_outgoing(id, "prices moved: the rate is now above the premium cap");
            return false;
        }
        let minted_max = mul_div(target_circulating.0, o.rate_ppm.0, RATE_SCALE);
        if minted_max > bps_of(self.circulating() + self.owed(), self.params.max_dilution_bps) {
            self.fail_outgoing(id, "dilution cap exceeded at execution");
            return false;
        }
        let now = self.now();
        self.outgoing.get_mut(&id).unwrap().status = OfferStatus::Executed;
        self.out_by_target.remove(&target);
        self.absorbed.insert(
            target.clone(),
            Absorbed {
                rate_ppm: o.rate_ppm,
                max_target_amount: target_circulating,
                converted: U128(0),
                at: now,
            },
        );
        let text = format!(
            "TAKEOVER of {target} executed: up to {} for its holders",
            fmt_tokens(minted_max)
        );
        self.emit(
            "takeover",
            json!({ "target": target, "rate_ppm": o.rate_ppm, "max_mint": U128(minted_max) }),
            text,
        );
        true
    }

    /// The target sends its curve NEAR and treasury after a merge.
    #[payable]
    pub fn absorb(&mut self, curve_near: U128, treasury: U128) {
        let from = env::predecessor_account_id();
        require!(self.absorbed.contains_key(&from), "only coins we absorbed");
        let deposit = env::attached_deposit().as_yoctonear();
        // The target's curve NEAR deepens our curve, so converted holders can sell.
        if self.status == CoinStatus::Active {
            self.amm_near += curve_near.0.min(deposit);
        }
        let text = format!(
            "absorbed {} from {from}",
            crate::market::fmt_near(deposit)
        );
        self.emit(
            "absorb",
            json!({ "from": from, "curve_near": curve_near, "treasury": treasury }),
            text,
        );
    }

    /// Mint our tokens for a holder of a coin we absorbed.
    pub fn mint_converted(&mut self, account_id: AccountId, amount: U128) -> U128 {
        let target = env::predecessor_account_id();
        let mut a = self.absorbed.get(&target).cloned().expect("only coins we absorbed");
        require!(
            a.converted.0 + amount.0 <= a.max_target_amount.0,
            "conversion exceeds the absorbed supply"
        );
        let out = mul_div(amount.0, a.rate_ppm.0, RATE_SCALE);
        self.ensure_registered(&account_id);
        self.token.internal_deposit(&account_id, out);
        let memo = format!("conversion from {target}");
        FtMint { owner_id: &account_id, amount: U128(out), memo: Some(&memo) }.emit();
        a.converted = U128(a.converted.0 + amount.0);
        self.absorbed.insert(target.clone(), a);
        let text = format!("minted {} for {account_id} (from {target})", fmt_tokens(out));
        self.emit("mint", json!({ "account": account_id, "amount": U128(out), "from": target }), text);
        U128(out)
    }

    /// The target countered one of our bids.
    pub fn receive_counter(&mut self, id: u64, rate_ppm: U128, pitch: String, by: Proposer) {
        let target = env::predecessor_account_id();
        let now = self.now();
        let o = self.outgoing.get_mut(&id).expect("unknown offer");
        require!(o.target == target, "not your offer");
        require!(o.status == OfferStatus::Open, "offer is not open");
        o.counter = Some(Counter { rate_ppm, pitch: truncate(pitch, MAX_PITCH_LEN), by, at: now });
        let text = format!("{target} countered our bid at {}", fmt_rate(rate_ppm.0));
        self.emit("counter_received", json!({ "offer_id": id, "rate_ppm": rate_ppm }), text);
    }

    #[private]
    pub fn on_counter_applied(
        &mut self,
        id: u64,
        #[callback_result] ack: Result<CounterAck, PromiseError>,
    ) -> bool {
        let Ok(ack) = ack else {
            env::log_str("the target refused to apply the counter");
            return false;
        };
        let Some(o) = self.outgoing.get_mut(&id) else { return false };
        o.rate_ppm = ack.rate_ppm;
        o.premium_bps = ack.premium_bps;
        o.vote_ends = ack.vote_ends;
        o.round = ack.round;
        o.veto = U128(0);
        o.counter = None;
        true
    }

    /// The target closed our bid without a deal.
    pub fn offer_closed(&mut self, id: u64, reason: String) {
        let target = env::predecessor_account_id();
        let o = self.outgoing.get(&id).expect("unknown offer");
        require!(o.target == target, "not your offer");
        if o.is_live() {
            self.fail_outgoing(id, &truncate(reason, 200));
        }
    }
}

impl Coin {
    /// A proposer needs `proposer_bps` locked since an earlier block (a lock
    /// made in the same transaction does not count), and stays locked for
    /// `lock_sec`: no flash buy-lock-propose-unlock-sell.
    pub(crate) fn assert_proposer(&mut self, lock_sec: u64) -> AccountId {
        let who = env::predecessor_account_id();
        let now = self.now();
        let need = bps_of(self.circulating(), self.params.proposer_bps).max(1);
        require!(
            self.weight_at(&who, now) >= need,
            "lock more tokens (in an earlier block) to make proposals by hand"
        );
        self.extend_vote_lock(&who, now + lock_sec * NS_PER_SEC);
        who
    }

    pub(crate) fn extend_vote_lock(&mut self, who: &AccountId, until: u64) {
        let cur = self.vote_lock_until.get(who).copied().unwrap_or(0);
        if until > cur {
            self.vote_lock_until.insert(who.clone(), until);
        }
    }

    /// Fair rate from both curves; rate must sit inside the premium/discount
    /// band and the deal must respect the buyer's dilution cap.
    fn check_terms(
        &self,
        rate_ppm: u128,
        buyer: &MarketSnapshot,
        target: &MarketSnapshot,
    ) -> (u128, i64) {
        let fair = fair_rate_ppm(
            target.amm_near.0,
            target.amm_tokens.0,
            buyer.amm_near.0,
            buyer.amm_tokens.0,
        );
        let premium = premium_bps(rate_ppm, fair);
        if let Err(e) = self.check_caps(rate_ppm, premium, buyer, target) {
            env::panic_str(&e);
        }
        (fair, premium)
    }

    fn check_caps(
        &self,
        rate_ppm: u128,
        premium: i64,
        buyer: &MarketSnapshot,
        target: &MarketSnapshot,
    ) -> Result<(), String> {
        if rate_ppm == 0 {
            return Err("rate must be positive".into());
        }
        if premium > self.params.max_premium_bps as i64 {
            return Err(format!(
                "premium {premium} bps is above the cap of {} bps",
                self.params.max_premium_bps
            ));
        }
        if premium < -(self.params.max_discount_bps as i64) {
            return Err(format!(
                "discount {} bps is below the floor of -{} bps",
                premium, self.params.max_discount_bps
            ));
        }
        let minted = mul_div(target.circulating.0 + target.owed.0, rate_ppm, RATE_SCALE);
        if minted > bps_of(buyer.circulating.0 + buyer.owed.0, self.params.max_dilution_bps) {
            return Err("deal would dilute the buyer beyond its cap".into());
        }
        Ok(())
    }

    pub(crate) fn try_make_offer(
        &mut self,
        target: AccountId,
        rate_ppm: u128,
        pitch: String,
        proposer: Proposer,
    ) -> Result<Promise, String> {
        if self.status != CoinStatus::Active {
            return Err("this coin is not active".into());
        }
        if !self.is_sibling(&target) {
            return Err(format!("{target} is not a coin from this launchpad"));
        }
        if rate_ppm == 0 {
            return Err("rate must be positive".into());
        }
        if self.out_by_target.contains_key(&target) || self.in_by_buyer.contains_key(&target) {
            return Err("one open offer per pair".into());
        }
        self.count_offer()?;
        let id = self.next_offer_id;
        self.next_offer_id += 1;
        let market = self.market();
        let pitch = truncate(pitch, MAX_PITCH_LEN);
        let offer = Offer {
            buyer: self.me(),
            target: target.clone(),
            id,
            rate_ppm: U128(rate_ppm),
            fair_rate_ppm: U128(0),
            premium_bps: 0,
            pitch: pitch.clone(),
            proposer: proposer.clone(),
            created_at: self.now(),
            vote_ends: 0,
            round: 0,
            counter: None,
            yes: U128(0),
            no: U128(0),
            sealed: U128(0),
            veto: U128(0),
            buyer_market: market.clone(),
            target_market: MarketSnapshot {
                amm_near: U128(0),
                amm_tokens: U128(0),
                circulating: U128(0),
                owed: U128(0),
            },
            status: OfferStatus::Sending,
        };
        self.outgoing.insert(id, offer);
        self.out_by_target.insert(target.clone(), id);
        Ok(Self::ext(target)
            .with_static_gas(GAS_RECEIVE_OFFER)
            .receive_offer(id, U128(rate_ppm), pitch, proposer, market)
            .then(Self::ext(self.me()).with_static_gas(GAS_ON_OFFER_SENT).on_offer_sent(id)))
    }

    /// Bids and tenders share one daily cap.
    pub(crate) fn count_offer(&mut self) -> Result<(), String> {
        let day = self.now() / DAY_NS;
        if day != self.offer_day {
            self.offer_day = day;
            self.offers_today = 0;
        }
        if self.offers_today >= self.params.max_offers_per_day {
            return Err("daily offer cap reached".into());
        }
        self.offers_today += 1;
        Ok(())
    }

    pub(crate) fn try_accept_counter(&mut self, offer_id: u64) -> Result<Promise, String> {
        if self.status != CoinStatus::Active {
            return Err("this coin is not active".into());
        }
        let o = self.outgoing.get(&offer_id).ok_or("unknown offer")?;
        if o.status != OfferStatus::Open || o.counter.is_none() {
            return Err("no counter to accept".into());
        }
        Ok(Self::ext(o.target.clone())
            .with_static_gas(GAS_APPLY_COUNTER)
            .apply_counter(offer_id)
            .then(
                Self::ext(self.me())
                    .with_static_gas(GAS_ON_COUNTER_APPLIED)
                    .on_counter_applied(offer_id),
            ))
    }

    fn fail_incoming(&mut self, key: &str, reason: &str) {
        let Some(o) = self.incoming.get_mut(key) else { return };
        o.status = OfferStatus::Failed { reason: reason.to_string() };
        let (buyer, id) = (o.buyer.clone(), o.id);
        self.in_by_buyer.remove(&buyer);
        self.last_failed.insert(buyer.clone(), env::block_timestamp());
        let text = format!("bid {key} failed: {reason}");
        self.emit("offer_failed", json!({ "offer": key, "reason": reason }), text);
        Self::ext(buyer)
            .with_static_gas(GAS_NOTIFY)
            .offer_closed(id, reason.to_string())
            .detach();
    }

    fn fail_outgoing(&mut self, id: u64, reason: &str) {
        let Some(o) = self.outgoing.get_mut(&id) else { return };
        o.status = OfferStatus::Failed { reason: reason.to_string() };
        let (target, key) = (o.target.clone(), o.key());
        self.out_by_target.remove(&target);
        let text = format!("our bid for {target} failed: {reason}");
        self.emit("offer_failed", json!({ "offer": key, "reason": reason }), text);
    }
}

pub(crate) fn fmt_rate(rate_ppm: u128) -> String {
    format!("{}.{:06}", rate_ppm / RATE_SCALE, rate_ppm % RATE_SCALE)
}
