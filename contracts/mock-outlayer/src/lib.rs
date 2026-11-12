//! A local stand-in for OutLayer, for the sandbox and tests only.
//!
//! It keeps OutLayer's `request_execution` interface and its behaviour as seen
//! by a caller: the call yields, an off-chain worker runs the WASM and resumes
//! it, and the caller's `.then()` callback receives the program's JSON output
//! (or `null` on failure/timeout). Unused deposit is refunded to the payer.
//! The worker here is `demo`'s local brain runner instead of a TEE.

use near_sdk::json_types::U128;
use near_sdk::serde_json::{self, Value, json};
use near_sdk::store::IterableMap;
use near_sdk::{
    AccountId, BorshStorageKey, CryptoHash, Gas, GasWeight, NearToken, PanicOnDefault, Promise, env, near, require,
};

const YIELD_REGISTER: u64 = 0;
const GAS_ON_RESOLVED: Gas = Gas::from_tgas(15);
/// What one run "costs"; the rest of the deposit is refunded.
const RUN_FEE: NearToken = NearToken::from_millinear(1);

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Pending {
    pub request_id: u64,
    #[serde(skip)]
    pub yield_id: CryptoHash,
    pub sender_id: AccountId,
    pub payer_id: AccountId,
    pub source: String,
    pub input_data: Option<String>,
    pub input_sha256: String,
    pub secrets_ref: Option<String>,
    pub deposit: U128,
    pub created_at: u64,
}

#[near]
#[derive(BorshStorageKey)]
enum Key {
    Pending,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct MockOutLayer {
    worker: AccountId,
    next_id: u64,
    pending: IterableMap<u64, Pending>,
}

#[near]
impl MockOutLayer {
    #[init]
    pub fn new(worker: AccountId) -> Self {
        Self { worker, next_id: 0, pending: IterableMap::new(Key::Pending) }
    }

    #[payable]
    #[allow(unused_variables)]
    pub fn request_execution(
        &mut self,
        source: Value,
        resource_limits: Option<Value>,
        input_data: Option<String>,
        secrets_ref: Option<Value>,
        response_format: Option<String>,
        payer_account_id: Option<AccountId>,
        params: Option<Value>,
    ) {
        let deposit = env::attached_deposit();
        require!(deposit >= RUN_FEE, "Insufficient payment");
        let request_id = self.next_id;
        self.next_id += 1;
        let args = serde_json::to_vec(&json!({ "request_id": request_id })).unwrap();
        let promise = env::promise_yield_create("on_resolved", &args, GAS_ON_RESOLVED, GasWeight(1), YIELD_REGISTER);
        let yield_id: CryptoHash =
            env::read_register(YIELD_REGISTER).expect("no yield id").try_into().expect("yield id is 32 bytes");
        let sender_id = env::predecessor_account_id();
        let input_sha256 = input_data.as_ref().map(|s| hex(&env::sha256(s.as_bytes()))).unwrap_or_default();
        self.pending.insert(
            request_id,
            Pending {
                request_id,
                yield_id,
                payer_id: payer_account_id.unwrap_or_else(|| sender_id.clone()),
                sender_id,
                source: source.to_string(),
                input_data,
                input_sha256,
                secrets_ref: secrets_ref.map(|v| v.to_string()),
                deposit: U128(deposit.as_yoctonear()),
                created_at: env::block_timestamp(),
            },
        );
        env::log_str(&format!("execution_requested {request_id}"));
        env::promise_return(promise);
    }

    /// The worker hands back the program's stdout (must be JSON).
    pub fn resolve(&mut self, request_id: u64, output: String) -> bool {
        require!(env::predecessor_account_id() == self.worker, "only the worker can resolve");
        serde_json::from_str::<Value>(&output).expect("output must be JSON");
        let p = self.pending.get(&request_id).expect("unknown request");
        env::promise_yield_resume(&p.yield_id, output.as_bytes())
    }

    /// Resumed by `resolve`, or by the runtime on timeout (~200 blocks).
    #[private]
    pub fn on_resolved(&mut self, request_id: u64) {
        let output = env::promise_result_checked(0, 64 * 1024).ok();
        if let Some(p) = self.pending.remove(&request_id) {
            let refund = p.deposit.0.saturating_sub(RUN_FEE.as_yoctonear());
            if refund > 0 {
                Promise::new(p.payer_id).transfer(NearToken::from_yoctonear(refund)).detach();
            }
            let output_sha256 = output.as_ref().map(|o| hex(&env::sha256(o))).unwrap_or_default();
            env::log_str(&format!(
                "EVENT_JSON:{}",
                json!({
                    "standard": "mock-outlayer", "version": "1.0.0", "event": "execution_resolved",
                    "data": [{ "request_id": request_id, "input_sha256": p.input_sha256, "output_sha256": output_sha256, "success": output.is_some() }]
                })
            ));
        }
        // Same contract as OutLayer: the caller receives the output JSON, or null.
        env::value_return(output.as_deref().unwrap_or(b"null"));
    }

    pub fn list_pending(&self) -> Vec<Pending> {
        self.pending.values().cloned().collect()
    }

    pub fn get_worker(&self) -> AccountId {
        self.worker.clone()
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
