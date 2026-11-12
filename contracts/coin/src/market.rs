//! The coin's own exchange (a constant-product curve with a virtual NEAR
//! reserve) and vote locks.

use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::{NearToken, Promise, assert_one_yocto, env, near, require};

use crate::math::{amm_out, bps_of};
use crate::types::*;
use crate::{Coin, CoinExt};

#[near]
impl Coin {
    /// Buy coins from the curve with the attached NEAR. Registers the buyer for
    /// storage out of the deposit if needed. A trading fee goes to the treasury.
    #[payable]
    pub fn buy(&mut self, min_out: Option<U128>) -> U128 {
        self.assert_active();
        let buyer = env::predecessor_account_id();
        let mut deposit = env::attached_deposit().as_yoctonear();
        if !self.token.accounts.contains_key(&buyer) {
            let cost = self.token.account_storage_usage as u128 * env::storage_byte_cost().as_yoctonear();
            require!(deposit > cost, "attach more NEAR: part of it pays for storage");
            deposit -= cost;
            self.token.internal_register_account(&buyer);
        }
        let fee = bps_of(deposit, self.params.trade_fee_bps);
        let net = deposit - fee;
        let out = amm_out(self.amm_near, self.amm_tokens, net);
        require!(out > 0 && out < self.amm_tokens, "trade too small or too large");
        if let Some(min) = min_out {
            require!(out >= min.0, "slippage: price moved");
        }
        self.amm_near += net;
        self.amm_tokens -= out;
        let me = self.me();
        self.token.internal_transfer(&me, &buyer, out, Some("buy".into()));
        let text = format!("{buyer} bought {} for {}", fmt_tokens(out), fmt_near(deposit));
        self.emit(
            "trade",
            json!({ "side": "buy", "account": buyer, "near": U128(deposit), "tokens": U128(out), "fee": U128(fee) }),
            text,
        );
        U128(out)
    }

    /// Sell coins back to the curve. Requires 1 yoctoNEAR.
    #[payable]
    pub fn sell(&mut self, amount: U128, min_out: Option<U128>) -> U128 {
        assert_one_yocto();
        self.assert_active();
        let seller = env::predecessor_account_id();
        let amount = amount.0;
        require!(amount > 0, "nothing to sell");
        let gross = amm_out(self.amm_tokens, self.amm_near, amount);
        require!(self.amm_near - gross >= self.params.virtual_near.0, "the curve has no real NEAR left for this sale");
        let fee = bps_of(gross, self.params.trade_fee_bps);
        let out = gross - fee;
        if let Some(min) = min_out {
            require!(out >= min.0, "slippage: price moved");
        }
        let me = self.me();
        self.token.internal_transfer(&seller, &me, amount, Some("sell".into()));
        self.amm_tokens += amount;
        self.amm_near -= gross;
        let text = format!("{seller} sold {} for {}", fmt_tokens(amount), fmt_near(out));
        self.emit(
            "trade",
            json!({ "side": "sell", "account": seller, "near": U128(out), "tokens": U128(amount), "fee": U128(fee) }),
            text,
        );
        Promise::new(seller).transfer(NearToken::from_yoctonear(out)).detach();
        U128(out)
    }

    /// Anyone may top up the treasury.
    #[payable]
    pub fn fund_treasury(&mut self) {
        let from = env::predecessor_account_id();
        let amount = env::attached_deposit();
        let text = format!("{from} added {} to the treasury", fmt_near(amount.as_yoctonear()));
        self.emit("treasury", json!({ "from": from, "amount": U128(amount.as_yoctonear()) }), text);
    }

    pub fn quote_buy(&self, near: U128) -> U128 {
        let net = near.0 - bps_of(near.0, self.params.trade_fee_bps);
        U128(amm_out(self.amm_near, self.amm_tokens, net))
    }

    pub fn quote_sell(&self, tokens: U128) -> U128 {
        let gross = amm_out(self.amm_tokens, self.amm_near, tokens.0);
        U128(gross - bps_of(gross, self.params.trade_fee_bps))
    }

    // ---------- vote locks ----------

    /// Lock tokens to get voting weight. Only tokens locked *before* an offer
    /// is announced can vote on it, so buying a coin to swing a live vote fails.
    pub fn lock(&mut self, amount: U128) {
        self.assert_active();
        let who = env::predecessor_account_id();
        let amount = amount.0;
        require!(amount > 0, "nothing to lock");
        let now = self.now();
        let mut lots = self.locks.get(&who).cloned().unwrap_or_default();
        if lots.len() >= MAX_LOTS {
            // Fold the newest lot into this one; the merged lot takes the newer
            // timestamp, which can only lower its weight.
            let last = lots.pop().unwrap();
            lots.push(Lot { amount: U128(last.amount.0 + amount), since: now });
        } else {
            lots.push(Lot { amount: U128(amount), since: now });
        }
        let me = self.me();
        self.token.internal_transfer(&who, &me, amount, Some("lock".into()));
        self.total_locked += amount;
        self.locks.insert(who.clone(), lots);
        let text = format!("{who} locked {}", fmt_tokens(amount));
        self.emit("lock", json!({ "account": who, "amount": U128(amount) }), text);
    }

    /// Unlock tokens, newest lots first so old (voting) lots survive longest.
    /// Tokens that backed a vote stay locked until that vote ends.
    pub fn unlock(&mut self, amount: U128) {
        let who = env::predecessor_account_id();
        let until = self.vote_lock_until.get(&who).copied().unwrap_or(0);
        require!(self.now() >= until, "these tokens back a vote that has not ended");
        let mut left = amount.0;
        require!(left > 0, "nothing to unlock");
        let mut lots = self.locks.get(&who).cloned().unwrap_or_default();
        while left > 0 {
            let Some(mut lot) = lots.pop() else {
                env::panic_str("not enough locked tokens");
            };
            if lot.amount.0 > left {
                lot.amount = U128(lot.amount.0 - left);
                left = 0;
                lots.push(lot);
            } else {
                left -= lot.amount.0;
            }
        }
        if lots.is_empty() {
            self.locks.remove(&who);
        } else {
            self.locks.insert(who.clone(), lots);
        }
        self.total_locked -= amount.0;
        let me = self.me();
        self.token.internal_transfer(&me, &who, amount.0, Some("unlock".into()));
        let text = format!("{who} unlocked {}", fmt_tokens(amount.0));
        self.emit("unlock", json!({ "account": who, "amount": amount }), text);
    }

    pub fn locks_of(&self, account_id: near_sdk::AccountId) -> Vec<Lot> {
        self.locks.get(&account_id).cloned().unwrap_or_default()
    }

    pub fn locked_until(&self, account_id: near_sdk::AccountId) -> u64 {
        self.vote_lock_until.get(&account_id).copied().unwrap_or(0)
    }
}

impl Coin {
    pub(crate) fn locked_of(&self, who: &near_sdk::AccountId) -> u128 {
        self.locks.get(who).map_or(0, |lots| lots.iter().map(|l| l.amount.0).sum())
    }

    /// Weight an account had locked strictly before `t`.
    pub(crate) fn weight_at(&self, who: &near_sdk::AccountId, t: u64) -> u128 {
        self.locks.get(who).map_or(0, |lots| lots.iter().filter(|l| l.since < t).map(|l| l.amount.0).sum())
    }
}

pub(crate) fn fmt_tokens(units: u128) -> String {
    let whole = units / 10u128.pow(18);
    format!("{whole} tokens")
}

pub(crate) fn fmt_near(yocto: u128) -> String {
    let milli = yocto / 10u128.pow(21);
    format!("{}.{:03} NEAR", milli / 1000, milli % 1000)
}
