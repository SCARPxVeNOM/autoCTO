//! AutoCTO coin: an NEP-141 memecoin with a takeover mechanic built in.
//!
//! Every coin is launched by the same launchpad with the same code and the same
//! fixed parameters. Coins can bid for each other; the target's holders vote,
//! the buyer's holders can veto, and a passed deal turns the target into a
//! convert-only coin whose holders swap into the buyer at the agreed rate.
//! An AI "brain" running on OutLayer may propose bids, counters and stances,
//! but everything it proposes goes through the same checks a human proposal does.
//!
//! There is no owner, no admin method and no setter.

mod brain;
mod market;
mod math;
mod takeover;
mod tender;
pub mod types;

use near_contract_standards::fungible_token::events::{FtBurn, FtMint};
use near_contract_standards::fungible_token::metadata::{
    FT_METADATA_SPEC, FungibleTokenMetadata, FungibleTokenMetadataProvider,
};
use near_contract_standards::fungible_token::{
    FungibleToken, FungibleTokenCore, FungibleTokenResolver,
};
use near_contract_standards::storage_management::{
    StorageBalance, StorageBalanceBounds, StorageManagement,
};
use near_sdk::json_types::U128;
use near_sdk::serde_json::{self, json};
use near_sdk::store::{IterableMap, LookupMap, LookupSet, Vector};
use near_sdk::{
    AccountId, BorshStorageKey, NearToken, PanicOnDefault, PromiseOrValue, env, near, require,
};

use crate::math::mul_div;
use crate::types::*;

const HISTORY_CAP: u32 = 64;

#[near]
#[derive(BorshStorageKey)]
enum Key {
    Ft,
    Locks,
    VoteLock,
    Voted,
    Incoming,
    Outgoing,
    InByBuyer,
    OutByTarget,
    LastFailed,
    Absorbed,
    Decisions,
    History,
    Tenders,
    TenderDeposits,
    TenderByToken,
    SealedBallots,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Coin {
    token: FungibleToken,
    name: String,
    symbol: String,
    icon: Option<String>,
    persona: String,
    creator: AccountId,
    launchpad: AccountId,
    born_at: u64,
    params: Params,
    brain: BrainConfig,
    status: CoinStatus,

    // Built-in bonding curve (constant product with a virtual NEAR reserve).
    amm_near: u128,
    amm_tokens: u128,

    // Vote locks.
    total_locked: u128,
    locks: LookupMap<AccountId, Vec<Lot>>,
    vote_lock_until: LookupMap<AccountId, u64>,
    voted: LookupSet<String>,

    // Offers we received (key "buyer#id") and offers we made (key id).
    next_offer_id: u64,
    incoming: IterableMap<String, Offer>,
    outgoing: IterableMap<u64, Offer>,
    in_by_buyer: LookupMap<AccountId, String>,
    out_by_target: LookupMap<AccountId, u64>,
    last_failed: LookupMap<AccountId, u64>,
    offer_day: u64,
    offers_today: u32,
    absorbed: IterableMap<AccountId, Absorbed>,

    // Brain accounting.
    brain_day: u64,
    brain_spent_today: u128,
    brain_spent_total: u128,
    last_think: u64,
    decisions: Vector<Decision>,

    history: Vector<HistoryEntry>,
    history_head: u32,

    // Tender offers for tokens from outside the launchpad.
    next_tender_id: u64,
    tenders: IterableMap<u64, Tender>,
    /// Outside tokens deposited, by "tender id|account".
    tender_deposits: LookupMap<String, u128>,
    tender_by_token: LookupMap<AccountId, u64>,
    /// Our tokens still to be minted for depositors of succeeded tenders.
    tender_owed: u128,
    watchlist: Vec<AccountId>,

    /// Sealed votes waiting for their reveal, by "offer|round|account".
    sealed_ballots: LookupMap<String, SealedBallot>,
}

/// "pepe.autocto.testnet" -> "autocto.testnet"
pub fn parent_of(account: &AccountId) -> Option<AccountId> {
    account.as_str().split_once('.').and_then(|(_, rest)| rest.parse().ok())
}

pub fn hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(HEX[(b >> 4) as usize] as char);
        s.push(HEX[(b & 0xf) as usize] as char);
    }
    s
}

pub fn truncate(mut s: String, max: usize) -> String {
    if s.len() > max {
        let mut cut = max;
        while !s.is_char_boundary(cut) {
            cut -= 1;
        }
        s.truncate(cut);
    }
    s
}

#[near]
impl Coin {
    /// Called once by the launchpad in the same batch that creates the account.
    #[init]
    pub fn new(
        name: String,
        symbol: String,
        icon: Option<String>,
        persona: String,
        creator: AccountId,
        params: Params,
        brain: BrainConfig,
    ) -> Self {
        let me = env::current_account_id();
        let launchpad = parent_of(&me).expect("a coin must be a sub-account of its launchpad");
        require!(
            env::predecessor_account_id() == launchpad,
            "only the launchpad can create a coin"
        );
        require!(params.total_supply.0 > 0 && params.virtual_near.0 > 0, "bad curve");

        let mut this = Self {
            token: FungibleToken::new(Key::Ft),
            name,
            symbol,
            icon,
            persona: truncate(persona, 1000),
            creator,
            launchpad,
            born_at: env::block_timestamp(),
            amm_near: params.virtual_near.0,
            amm_tokens: params.total_supply.0,
            params,
            brain,
            status: CoinStatus::Active,
            total_locked: 0,
            locks: LookupMap::new(Key::Locks),
            vote_lock_until: LookupMap::new(Key::VoteLock),
            voted: LookupSet::new(Key::Voted),
            next_offer_id: 0,
            incoming: IterableMap::new(Key::Incoming),
            outgoing: IterableMap::new(Key::Outgoing),
            in_by_buyer: LookupMap::new(Key::InByBuyer),
            out_by_target: LookupMap::new(Key::OutByTarget),
            last_failed: LookupMap::new(Key::LastFailed),
            offer_day: 0,
            offers_today: 0,
            absorbed: IterableMap::new(Key::Absorbed),
            brain_day: 0,
            brain_spent_today: 0,
            brain_spent_total: 0,
            last_think: 0,
            decisions: Vector::new(Key::Decisions),
            history: Vector::new(Key::History),
            history_head: 0,
            next_tender_id: 0,
            tenders: IterableMap::new(Key::Tenders),
            tender_deposits: LookupMap::new(Key::TenderDeposits),
            tender_by_token: LookupMap::new(Key::TenderByToken),
            tender_owed: 0,
            watchlist: Vec::new(),
            sealed_ballots: LookupMap::new(Key::SealedBallots),
        };
        this.token.internal_register_account(&me);
        this.token.internal_deposit(&me, this.params.total_supply.0);
        FtMint {
            owner_id: &me,
            amount: this.params.total_supply,
            memo: Some("born: whole supply sits in the coin's own curve"),
        }
        .emit();
        let text = format!("{} (${}) was born", this.name, this.symbol);
        this.emit("born", json!({ "coin": me, "symbol": this.symbol }), text);
        this
    }

    // ---------- views ----------

    pub fn coin_info(&self) -> CoinInfo {
        let now = env::block_timestamp();
        CoinInfo {
            account_id: env::current_account_id(),
            name: self.name.clone(),
            symbol: self.symbol.clone(),
            icon: self.icon.clone(),
            persona: self.persona.clone(),
            creator: self.creator.clone(),
            launchpad: self.launchpad.clone(),
            born_at: self.born_at,
            protected_until: self.protected_until(),
            status: self.status.clone(),
            total_supply: U128(self.token.total_supply),
            circulating: U128(self.circulating()),
            owed: U128(self.owed()),
            total_locked: U128(self.total_locked),
            amm_near: U128(self.amm_near),
            amm_tokens: U128(self.amm_tokens),
            price_yocto: U128(self.price_yocto()),
            treasury: U128(self.treasury()),
            brain_spent_total: U128(self.brain_spent_total),
            brain_spent_today: U128(if now / DAY_NS == self.brain_day {
                self.brain_spent_today
            } else {
                0
            }),
            last_think: self.last_think,
            decisions: self.decisions.len() as u64,
            absorbed: self.absorbed.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
            watchlist: self.watchlist.clone(),
        }
    }

    pub fn get_params(&self) -> Params {
        self.params.clone()
    }

    pub fn get_brain(&self) -> BrainConfig {
        self.brain.clone()
    }

    /// Offers this coin received and made. `live_only` hides finished ones.
    pub fn list_offers(&self, live_only: Option<bool>) -> Vec<Offer> {
        let live_only = live_only.unwrap_or(false);
        self.incoming
            .values()
            .chain(self.outgoing.values())
            .filter(|o| !live_only || o.is_live())
            .cloned()
            .collect()
    }

    pub fn get_incoming(&self, offer: String) -> Option<Offer> {
        self.incoming.get(&offer).cloned()
    }

    pub fn get_outgoing(&self, offer_id: u64) -> Option<Offer> {
        self.outgoing.get(&offer_id).cloned()
    }

    pub fn list_decisions(&self, from_index: Option<u64>, limit: Option<u64>) -> Vec<Decision> {
        let len = self.decisions.len() as u64;
        let limit = limit.unwrap_or(20).min(100);
        let from = from_index.unwrap_or(len.saturating_sub(limit));
        (from..len.min(from + limit))
            .filter_map(|i| self.decisions.get(i as u32).cloned())
            .collect()
    }

    pub fn get_decision(&self, id: u64) -> Option<Decision> {
        self.decisions.get(id as u32).cloned()
    }

    /// The last events, oldest first.
    pub fn history(&self) -> Vec<HistoryEntry> {
        let len = self.history.len();
        (0..len)
            .filter_map(|i| self.history.get((self.history_head + i) % len.max(1)).cloned())
            .collect()
    }

    // ---------- internals shared by the modules ----------

    fn now(&self) -> u64 {
        env::block_timestamp()
    }

    fn me(&self) -> AccountId {
        env::current_account_id()
    }

    fn protected_until(&self) -> u64 {
        self.born_at + self.params.newborn_protection_sec * NS_PER_SEC
    }

    /// Tokens held by people: everything outside the curve.
    fn circulating(&self) -> u128 {
        self.token.total_supply - self.amm_tokens
    }

    /// Tokens we will still mint for holders of coins we absorbed and for
    /// depositors of succeeded tenders. One floor
    /// over the total is never below the sum of per-conversion floors.
    fn owed(&self) -> u128 {
        self.absorbed
            .values()
            .map(|a| mul_div(a.max_target_amount.0 - a.converted.0, a.rate_ppm.0, RATE_SCALE))
            .sum::<u128>()
            + self.tender_owed
    }

    fn price_yocto(&self) -> u128 {
        mul_div(self.amm_near, 10u128.pow(18), self.amm_tokens.max(1))
    }

    fn market(&self) -> MarketSnapshot {
        MarketSnapshot {
            amm_near: U128(self.amm_near),
            amm_tokens: U128(self.amm_tokens),
            circulating: U128(self.circulating()),
            owed: U128(self.owed()),
        }
    }

    /// NEAR the coin may spend: balance minus storage, minus the curve's real
    /// NEAR (which backs holders' sells), minus a fixed reserve.
    fn treasury(&self) -> u128 {
        let balance = env::account_balance().as_yoctonear();
        let storage = env::storage_usage() as u128 * env::storage_byte_cost().as_yoctonear();
        let curve_real = self.amm_near.saturating_sub(self.params.virtual_near.0);
        balance
            .saturating_sub(storage)
            .saturating_sub(curve_real)
            .saturating_sub(self.params.reserve.0)
    }

    fn assert_active(&self) {
        require!(self.status == CoinStatus::Active, "this coin is not active");
    }

    fn is_sibling(&self, other: &AccountId) -> bool {
        // Only the launchpad can create its direct sub-accounts, and it only
        // ever deploys this code there with no access keys.
        other != &self.me()
            && other
                .as_str()
                .strip_suffix(&format!(".{}", self.launchpad))
                .is_some_and(|label| !label.is_empty() && !label.contains('.'))
    }

    fn emit(&mut self, event: &str, data: serde_json::Value, text: String) {
        env::log_str(&format!(
            "EVENT_JSON:{}",
            json!({ "standard": "autocto", "version": "1.0.0", "event": event, "data": [data] })
        ));
        let entry = HistoryEntry { at: env::block_timestamp(), event: event.to_string(), text };
        if self.history.len() < HISTORY_CAP {
            self.history.push(entry);
        } else {
            self.history.replace(self.history_head, entry);
            self.history_head = (self.history_head + 1) % HISTORY_CAP;
        }
    }

    fn ensure_registered(&mut self, account: &AccountId) {
        if !self.token.accounts.contains_key(account) {
            self.token.internal_register_account(account);
        }
    }
}

// ---------- NEP-141 / NEP-145 / NEP-148 ----------

#[near]
impl FungibleTokenCore for Coin {
    #[payable]
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        require!(receiver_id != env::current_account_id(), "use lock() or sell() instead");
        self.token.ft_transfer(receiver_id, amount, memo)
    }

    #[payable]
    fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<U128> {
        require!(receiver_id != env::current_account_id(), "use lock() or sell() instead");
        self.token.ft_transfer_call(receiver_id, amount, memo, msg)
    }

    fn ft_total_supply(&self) -> U128 {
        self.token.ft_total_supply()
    }

    fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        self.token.ft_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenResolver for Coin {
    #[private]
    fn ft_resolve_transfer(
        &mut self,
        sender_id: AccountId,
        receiver_id: AccountId,
        amount: U128,
    ) -> U128 {
        let (used, burned) =
            self.token.internal_ft_resolve_transfer(&sender_id, receiver_id, amount);
        if burned > 0 {
            FtBurn { owner_id: &sender_id, amount: U128(burned), memo: None }.emit();
        }
        used.into()
    }
}

#[near]
impl StorageManagement for Coin {
    #[payable]
    fn storage_deposit(
        &mut self,
        account_id: Option<AccountId>,
        registration_only: Option<bool>,
    ) -> StorageBalance {
        self.token.storage_deposit(account_id, registration_only)
    }

    #[payable]
    fn storage_withdraw(&mut self, amount: Option<NearToken>) -> StorageBalance {
        self.token.storage_withdraw(amount)
    }

    #[payable]
    fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        let who = env::predecessor_account_id();
        require!(
            self.locks.get(&who).is_none_or(|l| l.is_empty()),
            "unlock your tokens before unregistering"
        );
        if let Some((account_id, balance)) = self.token.internal_storage_unregister(force) {
            if balance > 0 {
                FtBurn { owner_id: &account_id, amount: U128(balance), memo: None }.emit();
            }
            true
        } else {
            false
        }
    }

    fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        self.token.storage_balance_bounds()
    }

    fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.token.storage_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenMetadataProvider for Coin {
    fn ft_metadata(&self) -> FungibleTokenMetadata {
        FungibleTokenMetadata {
            spec: FT_METADATA_SPEC.to_string(),
            name: self.name.clone(),
            symbol: self.symbol.clone(),
            icon: self.icon.clone(),
            reference: None,
            reference_hash: None,
            decimals: 18,
        }
    }
}
