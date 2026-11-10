//! AutoCTO launchpad: the factory every coin is born from.
//!
//! - Every coin is a direct sub-account (`<label>.<launchpad>`) with zero
//!   access keys, running the exact same coin code with the same rules.
//! - Coins recognise each other by that naming alone: only this contract can
//!   create its sub-accounts, and it only ever creates coins.
//! - The registry lists every coin, and each birth is a public event, so
//!   existing brains notice newcomers on their next think.
//!
//! Rules and code are fixed at init. There is no owner and no setter.

use near_sdk::json_types::{Base58CryptoHash, U128};
use near_sdk::serde_json::json;
use near_sdk::store::IterableMap;
use near_sdk::{
    AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, env, near, require,
};

/// The coin contract every launch deploys (built by `scripts/build.sh`).
const COIN_CODE: &[u8] = include_bytes!("../../../res/autocto_coin.wasm");

const GAS_COIN_INIT: Gas = Gas::from_tgas(40);
const GAS_ON_LAUNCHED: Gas = Gas::from_tgas(15);
/// NEAR a new coin starts with on top of its code storage: state, the
/// coin's fixed reserve and a little treasury.
const STARTING_BALANCE: NearToken = NearToken::from_millinear(1_000);

/// Same JSON shape as the coin's `Params` (checked by the integration tests).
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Params {
    pub total_supply: U128,
    pub virtual_near: U128,
    pub trade_fee_bps: u32,
    pub max_premium_bps: u32,
    pub max_discount_bps: u32,
    pub max_dilution_bps: u32,
    pub vote_period_sec: u64,
    pub quorum_bps: u32,
    pub approval_bps: u32,
    pub veto_bps: u32,
    pub proposer_bps: u32,
    pub rebid_cooldown_sec: u64,
    pub max_offers_per_day: u32,
    pub newborn_protection_sec: u64,
    pub brain_fee: U128,
    pub brain_daily_cap: U128,
    pub think_cooldown_sec: u64,
    pub reserve: U128,
    pub tender_period_sec: u64,
    pub tender_threshold_bps: u32,
    pub tender_max_dilution_bps: u32,
    pub reveal_period_sec: u64,
}

/// Same JSON shape as the coin's `BrainConfig`.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct BrainConfig {
    pub outlayer: AccountId,
    pub source: String,
    pub secrets_ref: Option<String>,
    pub max_instructions: u64,
}

/// How coins get their code.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub enum CodeMode {
    /// Each coin stores its own copy of the embedded code (~4.3 NEAR each).
    Embedded,
    /// Coins point at a global contract with this hash (cheap launches). The
    /// hash must be the sha256 of the embedded code; it is checked at init.
    Global { code_hash: Base58CryptoHash },
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub enum CoinState {
    Launching,
    Live,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct CoinEntry {
    pub account_id: AccountId,
    pub name: String,
    pub symbol: String,
    pub creator: AccountId,
    pub born_at: u64,
    pub state: CoinState,
}

#[near]
#[derive(BorshStorageKey)]
enum Key {
    Coins,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Launchpad {
    params: Params,
    brain: BrainConfig,
    code_mode: CodeMode,
    coins: IterableMap<AccountId, CoinEntry>,
}

#[near]
impl Launchpad {
    /// Only the account itself can initialise (in the deploy transaction).
    /// After init the deployer deletes the launchpad's keys.
    #[init]
    #[private]
    pub fn new(params: Params, brain: BrainConfig, code_mode: CodeMode) -> Self {
        validate(&params);
        near_sdk::serde_json::from_str::<near_sdk::serde_json::Value>(&brain.source)
            .expect("brain.source must be JSON");
        if let CodeMode::Global { code_hash } = &code_mode {
            let embedded: [u8; 32] = env::sha256_array(COIN_CODE);
            let given: near_sdk::CryptoHash = (*code_hash).into();
            require!(embedded == given, "global code hash must match the embedded coin code");
        }
        Self { params, brain, code_mode, coins: IterableMap::new(Key::Coins) }
    }

    /// Launch a coin at `<label>.<launchpad>`. Attach `min_launch_deposit()`;
    /// anything above it becomes the coin's starting treasury.
    #[payable]
    pub fn launch(
        &mut self,
        label: String,
        name: String,
        symbol: String,
        icon: Option<String>,
        persona: String,
    ) -> Promise {
        require!(valid_label(&label), "label: 2-32 chars of a-z, 0-9, - or _");
        require!((1..=40).contains(&name.len()), "name: 1-40 chars");
        require!((1..=12).contains(&symbol.len()), "symbol: 1-12 chars");
        require!(persona.len() <= 1000, "persona: at most 1000 chars");
        if let Some(icon) = &icon {
            require!(icon.len() <= 4096, "icon: at most 4096 chars (use a small data URL)");
        }
        let account_id: AccountId = format!("{label}.{}", env::current_account_id())
            .parse()
            .expect("bad account id");
        require!(!self.coins.contains_key(&account_id), "this label is taken");
        let deposit = env::attached_deposit();
        let min = self.min_launch_deposit();
        require!(deposit >= min, format!("attach at least {} yoctoNEAR", min.as_yoctonear()));

        let creator = env::predecessor_account_id();
        self.coins.insert(
            account_id.clone(),
            CoinEntry {
                account_id: account_id.clone(),
                name: name.clone(),
                symbol: symbol.clone(),
                creator: creator.clone(),
                born_at: env::block_timestamp(),
                state: CoinState::Launching,
            },
        );

        let init_args = json!({
            "name": name,
            "symbol": symbol,
            "icon": icon,
            "persona": persona,
            "creator": creator,
            "params": self.params,
            "brain": self.brain,
        })
        .to_string()
        .into_bytes();

        // No access key is ever added: the coin account is keyless from birth.
        let mut p = Promise::new(account_id.clone()).create_account().transfer(deposit);
        p = match &self.code_mode {
            CodeMode::Embedded => p.deploy_contract(COIN_CODE.to_vec()),
            CodeMode::Global { code_hash } => {
                p.use_global_contract(near_sdk::CryptoHash::from(*code_hash))
            }
        };
        p.function_call("new", init_args, NearToken::from_yoctonear(0), GAS_COIN_INIT).then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_ON_LAUNCHED)
                .on_launched(account_id, creator, U128(deposit.as_yoctonear())),
        )
    }

    #[private]
    pub fn on_launched(
        &mut self,
        account_id: AccountId,
        creator: AccountId,
        deposit: U128,
    ) -> bool {
        // The coin's init returns no value, so read the raw result.
        if env::promise_result_checked(0, 0).is_ok() {
            let entry = self.coins.get_mut(&account_id).expect("unknown coin");
            entry.state = CoinState::Live;
            let data = json!({ "coin": account_id, "symbol": entry.symbol, "creator": creator });
            env::log_str(&format!(
                "EVENT_JSON:{}",
                json!({ "standard": "autocto", "version": "1.0.0", "event": "coin_born", "data": [data] })
            ));
            true
        } else {
            // The whole batch rolled back and the deposit came back to us.
            self.coins.remove(&account_id);
            Promise::new(creator)
                .transfer(NearToken::from_yoctonear(deposit.0))
                .detach();
            false
        }
    }

    // ---------- views ----------

    pub fn list_coins(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<CoinEntry> {
        self.coins
            .values()
            .skip(from_index.unwrap_or(0) as usize)
            .take(limit.unwrap_or(100) as usize)
            .cloned()
            .collect()
    }

    pub fn get_coin(&self, account_id: AccountId) -> Option<CoinEntry> {
        self.coins.get(&account_id).cloned()
    }

    pub fn is_coin(&self, account_id: AccountId) -> bool {
        self.coins.get(&account_id).is_some_and(|c| c.state == CoinState::Live)
    }

    pub fn get_params(&self) -> Params {
        self.params.clone()
    }

    pub fn get_brain(&self) -> BrainConfig {
        self.brain.clone()
    }

    pub fn get_code_mode(&self) -> CodeMode {
        self.code_mode.clone()
    }

    /// sha256 of the coin code; compare with `code_hash` of any coin account.
    pub fn coin_code_hash(&self) -> Base58CryptoHash {
        env::sha256_array(COIN_CODE).into()
    }

    pub fn min_launch_deposit(&self) -> NearToken {
        let code_storage = match self.code_mode {
            CodeMode::Embedded => COIN_CODE.len() as u128,
            CodeMode::Global { .. } => 0,
        };
        env::storage_byte_cost()
            .saturating_mul(code_storage)
            .saturating_add(STARTING_BALANCE)
            .saturating_add(NearToken::from_yoctonear(self.params.reserve.0))
    }
}

fn valid_label(label: &str) -> bool {
    (2..=32).contains(&label.len())
        && label.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_')
        && !label.starts_with(['-', '_'])
        && !label.ends_with(['-', '_'])
}

fn validate(p: &Params) {
    let bps = [
        p.trade_fee_bps,
        p.max_discount_bps,
        p.quorum_bps,
        p.approval_bps,
        p.veto_bps,
        p.proposer_bps,
        p.tender_threshold_bps,
        p.tender_max_dilution_bps,
    ];
    require!(bps.iter().all(|b| *b <= 10_000), "a bps value is above 10000");
    require!(p.approval_bps > 5_000, "approval must be a majority");
    require!(p.trade_fee_bps <= 1_000, "fee above 10%");
    require!(p.max_premium_bps <= 100_000, "premium cap above 1000%");
    require!(p.max_dilution_bps <= 100_000, "dilution cap above 1000%");
    require!(p.vote_period_sec > 0 && p.max_offers_per_day > 0, "zero period or offer cap");
    require!(p.tender_period_sec > 0 && p.tender_threshold_bps > 0, "zero tender period or threshold");
    require!(p.total_supply.0 > 0 && p.virtual_near.0 > 0, "empty curve");
    require!(p.brain_daily_cap.0 >= p.brain_fee.0, "brain cap below one think");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels() {
        assert!(valid_label("pepe"));
        assert!(valid_label("dog-wif-hat"));
        assert!(!valid_label("a"));
        assert!(!valid_label("Pepe"));
        assert!(!valid_label("pe.pe"));
        assert!(!valid_label("-pepe"));
    }
}
