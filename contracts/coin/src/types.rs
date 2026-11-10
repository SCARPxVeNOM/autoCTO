use near_sdk::json_types::U128;
use near_sdk::{AccountId, near};

/// Exchange rates are "buyer tokens per 1 target token", scaled by 1e6.
pub const RATE_SCALE: u128 = 1_000_000;
pub const BPS: u128 = 10_000;
pub const NS_PER_SEC: u64 = 1_000_000_000;
pub const DAY_NS: u64 = 86_400 * NS_PER_SEC;
pub const MAX_PITCH_LEN: usize = 500;
pub const MAX_LOTS: usize = 8;
pub const MAX_WATCHLIST: usize = 8;

/// Every rule of the game. Fixed at launch by the launchpad, readable by anyone,
/// and there is no method that changes it afterwards.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Params {
    /// Total supply minted into the coin's own bonding curve at birth (in smallest units).
    pub total_supply: U128,
    /// Virtual NEAR in the curve, sets the starting price (yoctoNEAR).
    pub virtual_near: U128,
    /// Trading fee that flows into the treasury.
    pub trade_fee_bps: u32,
    /// Offered rate may be at most fair * (1 + max_premium).
    pub max_premium_bps: u32,
    /// Offered rate must be at least fair * (1 - max_discount).
    pub max_discount_bps: u32,
    /// Buyer tokens minted for the whole target may be at most this share of the
    /// buyer's circulating supply.
    pub max_dilution_bps: u32,
    pub vote_period_sec: u64,
    /// Turnout (yes + no) needed, as a share of the target's circulating supply.
    pub quorum_bps: u32,
    /// Share of the turnout that must vote yes.
    pub approval_bps: u32,
    /// Buyer holders can block a deal by locking-and-vetoing this share of the
    /// buyer's circulating supply.
    pub veto_bps: u32,
    /// Locked share a holder needs to make offers or counters by hand.
    pub proposer_bps: u32,
    /// After a failed bid the same buyer must wait this long to bid again.
    pub rebid_cooldown_sec: u64,
    pub max_offers_per_day: u32,
    pub newborn_protection_sec: u64,
    /// NEAR attached to every OutLayer call.
    pub brain_fee: U128,
    /// Most NEAR the treasury may spend on thinking per UTC day.
    pub brain_daily_cap: U128,
    pub think_cooldown_sec: u64,
    /// NEAR kept aside for storage growth; never counted as treasury.
    pub reserve: U128,
    /// How long holders of an outside token can deposit into a tender offer.
    pub tender_period_sec: u64,
    /// A tender succeeds only if this share of the outside token's total
    /// supply is deposited. It is the outside holders' vote.
    pub tender_threshold_bps: u32,
    /// Most tokens one tender may mint, as a share of our supply.
    pub tender_max_dilution_bps: u32,
}

/// Where the brain lives. Pinned at launch: a project version (wasm hash) or a
/// raw wasm URL + hash, so nobody can swap the brain later.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct BrainConfig {
    pub outlayer: AccountId,
    /// JSON of OutLayer's `ExecutionSource`, e.g.
    /// {"Project":{"project_id":"x.testnet/brain","version_key":"<sha256>"}}
    pub source: String,
    /// JSON of OutLayer's `SecretsReference`, or null.
    pub secrets_ref: Option<String>,
    pub max_instructions: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub enum CoinStatus {
    Active,
    /// A passed takeover is being executed by the buyer; trading and new offers pause.
    MergePending { into: AccountId },
    /// Convert-only: holders swap into `into` at `rate_ppm`.
    Merged { into: AccountId, rate_ppm: U128, at: u64 },
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Lot {
    pub amount: U128,
    /// Block timestamp (ns) when this lot was locked.
    pub since: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub enum Proposer {
    Brain { decision_id: u64 },
    Holder { account_id: AccountId },
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub enum OfferStatus {
    /// Buyer side only: sent, waiting for the target to accept the terms.
    Sending,
    Open,
    /// Target side only: vote passed, waiting for the buyer to execute.
    Executing,
    Executed,
    Failed { reason: String },
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Counter {
    pub rate_ppm: U128,
    pub pitch: String,
    pub by: Proposer,
    pub at: u64,
}

/// Market numbers a coin reports about itself when it bids.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct MarketSnapshot {
    pub amm_near: U128,
    pub amm_tokens: U128,
    pub circulating: U128,
    /// Tokens still owed to holders of coins this one absorbed, not yet
    /// converted. They count toward supply in every dilution and mint cap.
    pub owed: U128,
}

/// One takeover bid. Both coins keep a copy: the target's copy carries the vote,
/// the buyer's copy carries the veto.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Offer {
    pub buyer: AccountId,
    pub target: AccountId,
    pub id: u64,
    pub rate_ppm: U128,
    pub fair_rate_ppm: U128,
    pub premium_bps: i64,
    pub pitch: String,
    pub proposer: Proposer,
    /// Snapshot time: only tokens locked before this moment can vote or veto.
    pub created_at: u64,
    pub vote_ends: u64,
    /// Bumps when an accepted counter changes the terms; votes start over.
    pub round: u32,
    pub counter: Option<Counter>,
    pub yes: U128,
    pub no: U128,
    pub veto: U128,
    pub buyer_market: MarketSnapshot,
    pub target_market: MarketSnapshot,
    pub status: OfferStatus,
}

impl Offer {
    pub fn key(&self) -> String {
        offer_key(&self.buyer, self.id)
    }
    pub fn is_live(&self) -> bool {
        matches!(self.status, OfferStatus::Sending | OfferStatus::Open | OfferStatus::Executing)
    }
}

pub fn offer_key(buyer: &AccountId, id: u64) -> String {
    format!("{buyer}#{id}")
}

/// What the target answers when it accepts an offer for voting.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct OfferAck {
    pub created_at: u64,
    pub vote_ends: u64,
    pub fair_rate_ppm: U128,
    pub premium_bps: i64,
    pub target_market: MarketSnapshot,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct CounterAck {
    pub rate_ppm: U128,
    pub premium_bps: i64,
    pub vote_ends: u64,
    pub round: u32,
}

/// What the buyer remembers about a coin it swallowed.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Absorbed {
    pub rate_ppm: U128,
    /// Target circulating supply at execution, plus what the target still
    /// owed its own absorbed coins: conversions can never exceed it.
    pub max_target_amount: U128,
    pub converted: U128,
    pub at: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub enum DecisionStatus {
    Pending,
    Applied,
    /// The brain answered, but the contract refused the proposal.
    Refused { reason: String },
    /// OutLayer returned nothing (failed run or timeout).
    NoAnswer,
}

/// One brain run, kept for the "verify this decision" link.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Decision {
    pub id: u64,
    pub requested_at: u64,
    pub requested_by: AccountId,
    pub paid: U128,
    pub paid_by_treasury: bool,
    /// sha256 of the exact input given to OutLayer; matches the TEE attestation.
    pub input_sha256: String,
    pub answered_at: Option<u64>,
    /// The brain's raw answer (truncated to 2000 bytes).
    pub output: Option<String>,
    pub status: DecisionStatus,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub enum TenderStatus {
    /// Registering with the outside token and reading its supply.
    Opening,
    Open,
    /// Depositors claim our tokens at the tender rate.
    Succeeded,
    /// Depositors claim their deposit back.
    Failed { reason: String },
}

/// An all-or-nothing offer to holders of a token from outside the launchpad:
/// "send me your OLD by the deadline and get `rate` of mine for each".
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Tender {
    pub id: u64,
    pub token: AccountId,
    /// Our smallest units per one smallest unit of the outside token, x1e6.
    pub rate_ppm: U128,
    pub pitch: String,
    pub proposer: Proposer,
    /// Snapshot time for our holders' veto.
    pub created_at: u64,
    pub deadline: u64,
    pub token_supply: U128,
    /// Deposits needed for the tender to succeed.
    pub threshold: U128,
    /// Deposits accepted at most (the dilution cap, in outside tokens).
    pub max_deposit: U128,
    pub deposited: U128,
    pub claimed: U128,
    pub veto: U128,
    /// Our circulating supply (plus owed) at the snapshot.
    pub buyer_supply: U128,
    pub status: TenderStatus,
}

/// Everything the brain may propose. It supplies names from the registry and
/// numbers; the contract does the checking.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum BrainAction {
    None,
    Offer { target: AccountId, rate_ppm: U128, pitch: String },
    Counter { offer: String, rate_ppm: U128, pitch: String },
    AcceptCounter { offer_id: u64 },
    /// Public opinion on an offer; carries no power.
    Stance { offer: String, support: bool, pitch: String },
    /// Tender for an outside token. Only tokens holders put on the watchlist.
    Tender { token: AccountId, rate_ppm: U128, pitch: String },
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct BrainOutput {
    pub action: BrainAction,
    #[serde(default)]
    pub thought: Option<String>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct HistoryEntry {
    pub at: u64,
    pub event: String,
    pub text: String,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct CoinInfo {
    pub account_id: AccountId,
    pub name: String,
    pub symbol: String,
    pub icon: Option<String>,
    pub persona: String,
    pub creator: AccountId,
    pub launchpad: AccountId,
    pub born_at: u64,
    pub protected_until: u64,
    pub status: CoinStatus,
    pub total_supply: U128,
    pub circulating: U128,
    /// Still to be minted for holders of absorbed coins.
    pub owed: U128,
    pub total_locked: U128,
    pub amm_near: U128,
    pub amm_tokens: U128,
    /// yoctoNEAR per whole token (1e18 units).
    pub price_yocto: U128,
    pub treasury: U128,
    pub brain_spent_total: U128,
    pub brain_spent_today: U128,
    pub last_think: u64,
    pub decisions: u64,
    pub absorbed: Vec<(AccountId, Absorbed)>,
    /// Outside tokens holders asked the brain to size up for a tender.
    pub watchlist: Vec<AccountId>,
}
