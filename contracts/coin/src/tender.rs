//! Tender offers for tokens from outside the launchpad.
//!
//! An outside NEP-141 token cannot run our code or hold a vote, so the bid is
//! all-or-nothing: its holders deposit by the deadline, and if enough of the
//! supply shows up everyone is swapped at the tender rate; otherwise everyone
//! takes their deposit back. The threshold is the vote.
//!
//! try_open_tender -> (token) storage_deposit, ft_total_supply -> on_tender_opened
//! (token) ft_transfer_call -> ft_on_transfer ... settle_tender -> claim_tender

use near_contract_standards::fungible_token::events::FtMint;
use near_contract_standards::fungible_token::receiver::FungibleTokenReceiver;
use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::{
    AccountId, Gas, NearToken, Promise, PromiseError, PromiseOrValue, env, ext_contract, near,
    require,
};

use crate::market::fmt_tokens;
use crate::math::{bps_of, mul_div};
use crate::takeover::fmt_rate;
use crate::types::*;
use crate::{Coin, CoinExt, truncate};

const GAS_FT_REGISTER: Gas = Gas::from_tgas(10);
const GAS_FT_VIEW: Gas = Gas::from_tgas(5);
const GAS_ON_TENDER_OPENED: Gas = Gas::from_tgas(15);
const GAS_FT_TRANSFER: Gas = Gas::from_tgas(15);
const GAS_ON_TENDER_REFUND: Gas = Gas::from_tgas(10);
/// Sent with `storage_deposit` so we can hold the outside token (NEP-145).
/// `registration_only` makes the token refund what it does not need.
const REGISTRATION: NearToken = NearToken::from_millinear(13);

#[ext_contract(ext_ft)]
#[allow(dead_code)]
trait OutsideToken {
    fn storage_deposit(&mut self, account_id: Option<AccountId>, registration_only: Option<bool>);
    fn ft_total_supply(&self) -> U128;
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
}

fn deposit_key(id: u64, who: &AccountId) -> String {
    format!("{id}|{who}")
}

#[near]
impl Coin {
    /// Ask the brain to size up an outside token. The brain may only tender
    /// for tokens on this list: holders pick the token, the brain the numbers.
    pub fn nominate(&mut self, token: AccountId) {
        let who = self.assert_proposer();
        require!(token != self.me() && !self.is_sibling(&token), "siblings get takeover bids");
        require!(!self.watchlist.contains(&token), "already on the watchlist");
        require!(self.watchlist.len() < MAX_WATCHLIST, "the watchlist is full");
        self.watchlist.push(token.clone());
        let text = format!("{who} put {token} on the watchlist");
        self.emit("nominated", json!({ "token": token, "by": who }), text);
    }

    /// Open a tender for an outside token by hand. Needs `proposer_bps` locked.
    pub fn propose_tender(&mut self, token: AccountId, rate_ppm: U128, pitch: String) -> Promise {
        let who = self.assert_proposer();
        self.try_open_tender(token, rate_ppm.0, pitch, Proposer::Holder { account_id: who })
            .unwrap_or_else(|e| env::panic_str(&e))
    }

    #[private]
    pub fn on_tender_opened(
        &mut self,
        id: u64,
        #[callback_result] supply: Result<U128, PromiseError>,
    ) -> bool {
        let Some(t) = self.tenders.get(&id).cloned() else { return false };
        let supply = supply.map(|s| s.0).unwrap_or(0);
        if supply == 0 {
            self.fail_tender(id, "the token did not report a supply");
            return false;
        }
        let threshold = bps_of(supply, self.params.tender_threshold_bps).max(1);
        let max_mint = bps_of(t.buyer_supply.0, self.params.tender_max_dilution_bps);
        let max_deposit = mul_div(max_mint, RATE_SCALE, t.rate_ppm.0);
        if max_deposit < threshold {
            self.fail_tender(id, "at this rate the threshold would break the dilution cap");
            return false;
        }
        let deadline = self.now() + self.params.tender_period_sec * NS_PER_SEC;
        let t2 = self.tenders.get_mut(&id).unwrap();
        t2.token_supply = U128(supply);
        t2.threshold = U128(threshold);
        t2.max_deposit = U128(max_deposit);
        t2.deadline = deadline;
        t2.status = TenderStatus::Open;
        let text = format!(
            "TENDER for {}: {} of ours per token if {} are deposited: \"{}\"",
            t.token,
            fmt_rate(t.rate_ppm.0),
            threshold,
            t.pitch
        );
        self.emit(
            "tender_opened",
            json!({ "tender": id, "token": t.token, "rate_ppm": t.rate_ppm, "threshold": U128(threshold),
                    "max_deposit": U128(max_deposit), "deadline": deadline.to_string() }),
            text,
        );
        true
    }

    /// Veto a tender our coin opened, with tokens locked before it was announced.
    pub fn veto_tender(&mut self, tender_id: u64) -> U128 {
        let who = env::predecessor_account_id();
        let t = self.tenders.get(&tender_id).cloned().expect("unknown tender");
        require!(
            t.status == TenderStatus::Open && self.now() < t.deadline,
            "veto window is closed"
        );
        let weight = self.weight_at(&who, t.created_at);
        require!(weight > 0, "no tokens locked before this tender was announced");
        require!(self.voted.insert(format!("tender|{tender_id}|{who}")), "already vetoed");
        let t2 = self.tenders.get_mut(&tender_id).unwrap();
        t2.veto = U128(t2.veto.0 + weight);
        let veto = t2.veto;
        self.extend_vote_lock(&who, t.deadline);
        let text = format!("{who} vetoed the tender for {} with {}", t.token, fmt_tokens(weight));
        self.emit("tender_veto", json!({ "tender": tender_id, "account": who, "veto": veto }), text);
        veto
    }

    /// After the deadline anyone settles: swap everyone, or refund everyone.
    pub fn settle_tender(&mut self, tender_id: u64) -> bool {
        let t = self.tenders.get(&tender_id).cloned().expect("unknown tender");
        require!(t.status == TenderStatus::Open, "tender is not open");
        require!(self.now() >= t.deadline, "the deadline has not passed");
        let veto_needed = bps_of(t.buyer_supply.0, self.params.veto_bps);
        let verdict = if self.status != CoinStatus::Active {
            Err("we are no longer active")
        } else if t.veto.0 > 0 && t.veto.0 >= veto_needed {
            Err("vetoed by our holders")
        } else if t.deposited.0 < t.threshold.0 {
            Err("threshold not reached")
        } else {
            Ok(())
        };
        if let Err(reason) = verdict {
            self.fail_tender(tender_id, reason);
            return false;
        }
        self.tenders.get_mut(&tender_id).unwrap().status = TenderStatus::Succeeded;
        self.tender_by_token.remove(&t.token);
        let mint = mul_div(t.deposited.0, t.rate_ppm.0, RATE_SCALE);
        self.tender_owed += mint;
        let text = format!(
            "TENDER for {} succeeded: {} deposited, up to {} of ours to claim",
            t.token,
            t.deposited.0,
            fmt_tokens(mint)
        );
        self.emit(
            "tender_succeeded",
            json!({ "tender": tender_id, "token": t.token, "deposited": t.deposited, "max_mint": U128(mint) }),
            text,
        );
        true
    }

    /// A depositor takes our tokens (tender succeeded) or the deposit back
    /// (tender failed). Returns what was minted or refunded.
    pub fn claim_tender(&mut self, tender_id: u64) -> PromiseOrValue<U128> {
        let who = env::predecessor_account_id();
        let t = self.tenders.get(&tender_id).cloned().expect("unknown tender");
        let key = deposit_key(tender_id, &who);
        let amount = self.tender_deposits.get(&key).copied().unwrap_or(0);
        require!(amount > 0, "nothing to claim");
        match t.status {
            TenderStatus::Succeeded => {
                self.tender_deposits.remove(&key);
                let out = mul_div(amount, t.rate_ppm.0, RATE_SCALE);
                self.ensure_registered(&who);
                self.token.internal_deposit(&who, out);
                self.tender_owed = self.tender_owed.saturating_sub(out);
                let t2 = self.tenders.get_mut(&tender_id).unwrap();
                t2.claimed = U128(t2.claimed.0 + amount);
                let memo = format!("tender for {}", t.token);
                FtMint { owner_id: &who, amount: U128(out), memo: Some(&memo) }.emit();
                let text = format!("minted {} for {who} (tendered {})", fmt_tokens(out), t.token);
                self.emit("tender_claim", json!({ "tender": tender_id, "account": who, "amount": U128(out) }), text);
                PromiseOrValue::Value(U128(out))
            }
            TenderStatus::Failed { .. } => {
                self.tender_deposits.remove(&key);
                PromiseOrValue::Promise(
                    ext_ft::ext(t.token)
                        .with_attached_deposit(NearToken::from_yoctonear(1))
                        .with_static_gas(GAS_FT_TRANSFER)
                        .ft_transfer(who.clone(), U128(amount), Some("tender refunded".into()))
                        .then(
                            Self::ext(self.me())
                                .with_static_gas(GAS_ON_TENDER_REFUND)
                                .on_tender_refund(tender_id, who, U128(amount)),
                        ),
                )
            }
            _ => env::panic_str("the tender is not settled yet"),
        }
    }

    #[private]
    pub fn on_tender_refund(
        &mut self,
        tender_id: u64,
        account_id: AccountId,
        amount: U128,
        #[callback_result] sent: Result<(), PromiseError>,
    ) -> U128 {
        if sent.is_ok() {
            let text = format!("refunded {} of the tendered token to {account_id}", amount.0);
            self.emit("tender_refund", json!({ "tender": tender_id, "account": account_id, "amount": amount }), text);
            return amount;
        }
        // The token refused the transfer: the deposit stays claimable.
        let key = deposit_key(tender_id, &account_id);
        let cur = self.tender_deposits.get(&key).copied().unwrap_or(0);
        self.tender_deposits.insert(key, cur + amount.0);
        U128(0)
    }

    pub fn list_tenders(&self, live_only: Option<bool>) -> Vec<Tender> {
        let live_only = live_only.unwrap_or(false);
        self.tenders
            .values()
            .filter(|t| !live_only || matches!(t.status, TenderStatus::Opening | TenderStatus::Open))
            .cloned()
            .collect()
    }

    pub fn get_tender(&self, tender_id: u64) -> Option<Tender> {
        self.tenders.get(&tender_id).cloned()
    }

    pub fn tender_deposit_of(&self, tender_id: u64, account_id: AccountId) -> U128 {
        U128(self.tender_deposits.get(&deposit_key(tender_id, &account_id)).copied().unwrap_or(0))
    }
}

/// Deposits arrive as `token.ft_transfer_call(coin, amount, msg = "<tender id>")`.
#[near]
impl FungibleTokenReceiver for Coin {
    fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        let token = env::predecessor_account_id();
        // Any panic here makes the token return the whole transfer.
        let id: u64 = msg.trim().parse().unwrap_or_else(|_| env::panic_str("msg must be a tender id"));
        let t = self.tenders.get(&id).cloned().expect("unknown tender");
        require!(t.token == token, "this tender is for another token");
        require!(t.status == TenderStatus::Open && self.now() < t.deadline, "the tender is closed");
        let accepted = amount.0.min(t.max_deposit.0 - t.deposited.0);
        require!(accepted > 0, "the tender is full");
        let key = deposit_key(id, &sender_id);
        let cur = self.tender_deposits.get(&key).copied().unwrap_or(0);
        self.tender_deposits.insert(key, cur + accepted);
        let t2 = self.tenders.get_mut(&id).unwrap();
        t2.deposited = U128(t2.deposited.0 + accepted);
        let total = t2.deposited;
        let text = format!("{sender_id} tendered {accepted} of {token}");
        self.emit(
            "tender_deposit",
            json!({ "tender": id, "account": sender_id, "amount": U128(accepted), "deposited": total }),
            text,
        );
        PromiseOrValue::Value(U128(amount.0 - accepted))
    }
}

impl Coin {
    pub(crate) fn try_open_tender(
        &mut self,
        token: AccountId,
        rate_ppm: u128,
        pitch: String,
        proposer: Proposer,
    ) -> Result<Promise, String> {
        if self.status != CoinStatus::Active {
            return Err("this coin is not active".into());
        }
        if token == self.me() || self.is_sibling(&token) {
            return Err(format!("{token} is a launchpad coin: make a takeover bid instead"));
        }
        if rate_ppm == 0 {
            return Err("rate must be positive".into());
        }
        if self.tender_by_token.contains_key(&token) {
            return Err("one open tender per token".into());
        }
        if self.treasury() < REGISTRATION.as_yoctonear() {
            return Err("the treasury cannot pay the token registration".into());
        }
        self.count_offer()?;
        let id = self.next_tender_id;
        self.next_tender_id += 1;
        let tender = Tender {
            id,
            token: token.clone(),
            rate_ppm: U128(rate_ppm),
            pitch: truncate(pitch, MAX_PITCH_LEN),
            proposer,
            created_at: self.now(),
            deadline: 0,
            token_supply: U128(0),
            threshold: U128(0),
            max_deposit: U128(0),
            deposited: U128(0),
            claimed: U128(0),
            veto: U128(0),
            buyer_supply: U128(self.circulating() + self.owed()),
            status: TenderStatus::Opening,
        };
        self.tenders.insert(id, tender);
        self.tender_by_token.insert(token.clone(), id);
        Ok(ext_ft::ext(token.clone())
            .with_attached_deposit(REGISTRATION)
            .with_static_gas(GAS_FT_REGISTER)
            .storage_deposit(Some(self.me()), Some(true))
            .then(ext_ft::ext(token).with_static_gas(GAS_FT_VIEW).ft_total_supply())
            .then(Self::ext(self.me()).with_static_gas(GAS_ON_TENDER_OPENED).on_tender_opened(id)))
    }

    fn fail_tender(&mut self, id: u64, reason: &str) {
        let Some(t) = self.tenders.get_mut(&id) else { return };
        t.status = TenderStatus::Failed { reason: reason.to_string() };
        let token = t.token.clone();
        self.tender_by_token.remove(&token);
        let text = format!("tender for {token} failed: {reason}; deposits can be claimed back");
        self.emit("tender_failed", json!({ "tender": id, "token": token, "reason": reason }), text);
    }
}
