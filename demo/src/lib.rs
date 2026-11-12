//! A whole AutoCTO world in a local NEAR sandbox.
//!
//! Used by the integration tests and by the `autocto-demo` binary. It deploys
//! the launchpad and a local OutLayer stand-in, creates holders, and plays the
//! OutLayer worker: it picks up pending brain runs, runs the brain natively
//! and resumes the yielded call with the brain's answer.

pub mod gasless;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result, anyhow};
use near_api::types::transaction::result::ExecutionFinalResult;
use near_api::{AccountId, Contract, NearGas, NearToken, NetworkConfig, Signer};
use serde_json::{Value, json};

pub const ONE_TOKEN: u128 = 1_000_000_000_000_000_000;
pub const ONE_NEAR: u128 = 1_000_000_000_000_000_000_000_000;

pub fn res_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../res")
}

pub fn read_res(name: &str) -> Result<Vec<u8>> {
    let p = res_dir().join(name);
    std::fs::read(&p).with_context(|| format!("missing {} - run ./scripts/build.sh first", p.display()))
}

/// Game rules used by the local demo and the tests: real mechanics, short clocks.
pub fn demo_params() -> Value {
    json!({
        "total_supply": (1_000_000_000u128 * ONE_TOKEN).to_string(),
        "virtual_near": (30 * ONE_NEAR).to_string(),
        "trade_fee_bps": 100,
        "max_premium_bps": 3000,
        "max_discount_bps": 3000,
        "max_dilution_bps": 10000,
        "vote_period_sec": 60,
        "quorum_bps": 1000,
        "approval_bps": 6700,
        "veto_bps": 1000,
        "proposer_bps": 100,
        "rebid_cooldown_sec": 120,
        "max_offers_per_day": 3,
        "newborn_protection_sec": 30,
        "brain_fee": (ONE_NEAR / 20).to_string(),
        "brain_daily_cap": ONE_NEAR.to_string(),
        "think_cooldown_sec": 5,
        "reserve": (ONE_NEAR / 2).to_string(),
        "tender_period_sec": 60,
        "tender_threshold_bps": 4000,
        "tender_max_dilution_bps": 2000,
        "reveal_period_sec": 0,
    })
}

/// Signs and sends; cheap to clone into tasks.
#[derive(Clone)]
pub struct Caller {
    pub net: NetworkConfig,
    pub signer: Arc<Signer>,
}

impl Caller {
    pub async fn call(
        &self,
        from: &AccountId,
        contract: &AccountId,
        method: &str,
        args: Value,
        deposit: u128,
    ) -> Result<ExecutionFinalResult> {
        let r = Contract(contract.clone())
            .call_function(method, args)
            .transaction()
            .deposit(NearToken::from_yoctonear(deposit))
            .gas(NearGas::from_tgas(300))
            .with_signer(from.clone(), self.signer.clone())
            .send_to(&self.net)
            .await
            .map_err(|e| anyhow!("{method}: {e}"))?;
        r.into_full().ok_or_else(|| anyhow!("{method}: transaction still pending"))
    }

    /// Call and require success of the transaction and of every receipt.
    pub async fn ok(
        &self,
        from: &AccountId,
        contract: &AccountId,
        method: &str,
        args: Value,
        deposit: u128,
    ) -> Result<Value> {
        let r = self.call(from, contract, method, args, deposit).await?;
        let failures = r.receipt_failures().iter().map(|o| format!("{o:?}")).collect::<Vec<_>>();
        if r.is_failure() || !failures.is_empty() {
            return Err(anyhow!("{method} failed: {:?} {:?}", failures, r.logs()));
        }
        Ok(r.json::<Value>().unwrap_or(Value::Null))
    }

    pub async fn view(&self, contract: &AccountId, method: &str, args: Value) -> Result<Value> {
        let d = Contract(contract.clone())
            .call_function(method, args)
            .read_only::<Value>()
            .fetch_from(&self.net)
            .await
            .map_err(|e| anyhow!("view {contract}.{method}: {e}"))?;
        Ok(d.data)
    }

    pub async fn near_balance(&self, account: &AccountId) -> Result<u128> {
        let b = near_api::Tokens::account(account.clone())
            .near_balance()
            .fetch_from(&self.net)
            .await
            .map_err(|e| anyhow!("balance: {e}"))?;
        Ok(b.total.as_yoctonear())
    }
}

pub struct World {
    pub sandbox: near_sandbox::Sandbox,
    pub caller: Caller,
    pub root: AccountId,
    pub launchpad: AccountId,
    pub outlayer: AccountId,
    pub worker: AccountId,
}

pub fn u128_of(v: &Value) -> u128 {
    match v {
        Value::String(s) => s.parse().unwrap_or(0),
        Value::Number(n) => n.as_u64().unwrap_or(0) as u128,
        _ => 0,
    }
}

impl World {
    /// Start a sandbox and deploy the mock OutLayer and the launchpad.
    pub async fn start(params: Value, global_code: bool, rpc_port: Option<u16>) -> Result<World> {
        let config = near_sandbox::SandboxConfig { rpc_port, ..Default::default() };
        let sandbox = near_sandbox::Sandbox::start_sandbox_with_config(config).await?;
        let net = NetworkConfig::from_rpc_url("sandbox", sandbox.rpc_addr.parse()?);
        let signer = Signer::from_secret_key(near_sandbox::config::DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY.parse()?)?;
        let caller = Caller { net, signer };
        let root: AccountId = "sandbox".parse()?;

        let mut world = World {
            sandbox,
            caller,
            root,
            launchpad: "autocto.sandbox".parse()?,
            outlayer: "outlayer.sandbox".parse()?,
            worker: "worker.sandbox".parse()?,
        };
        world.new_account("worker", 50).await?;
        world.new_account("outlayer", 20).await?;
        world.new_account("autocto", 100).await?;

        Contract::deploy(world.outlayer.clone())
            .use_code(read_res("mock_outlayer.wasm")?)
            .with_init_call("new", json!({ "worker": world.worker }))?
            .with_signer(world.caller.signer.clone())
            .send_to(&world.caller.net)
            .await?
            .assert_success();

        let coin_code = read_res("autocto_coin.wasm")?;
        let code_hash = near_api::types::CryptoHash::hash(&coin_code);
        let code_mode = if global_code {
            // Publish the coin code once as a global contract, by hash.
            near_api::Contract::deploy_global_contract_code(coin_code.clone())
                .as_hash()
                .with_signer(world.root.clone(), world.caller.signer.clone())
                .send_to(&world.caller.net)
                .await?
                .assert_success();
            json!({ "Global": { "code_hash": code_hash.to_string() } })
        } else {
            json!("Embedded")
        };
        let brain_hash = sha256_hex(&read_res("autocto-brain.wasm")?);
        let brain = json!({
            "outlayer": world.outlayer,
            "source": json!({ "WasmUrl": {
                "url": "https://local.sandbox/autocto-brain.wasm",
                "hash": brain_hash,
                "build_target": "wasm32-wasip2"
            }}).to_string(),
            "secrets_ref": null,
            "max_instructions": 10_000_000_000u64,
        });
        Contract::deploy(world.launchpad.clone())
            .use_code(read_res("autocto_launchpad.wasm")?)
            .with_init_call("new", json!({ "params": params, "brain": brain, "code_mode": code_mode }))?
            .with_signer(world.caller.signer.clone())
            .send_to(&world.caller.net)
            .await?
            .assert_success();
        Ok(world)
    }

    pub fn rpc_url(&self) -> String {
        self.sandbox.rpc_addr.clone()
    }

    pub async fn new_account(&mut self, name: &str, near: u128) -> Result<AccountId> {
        let id: AccountId = format!("{name}.{}", self.root).parse()?;
        self.sandbox.create_account(id.as_str().parse()?).initial_balance(NearToken::from_near(near)).send().await?;
        Ok(id)
    }

    pub async fn launch(
        &self,
        creator: &AccountId,
        label: &str,
        name: &str,
        symbol: &str,
        persona: &str,
        extra_near: u128,
    ) -> Result<AccountId> {
        let min = u128_of(&self.caller.view(&self.launchpad, "min_launch_deposit", json!({})).await?);
        let res = self
            .caller
            .ok(
                creator,
                &self.launchpad,
                "launch",
                json!({ "label": label, "name": name, "symbol": symbol, "icon": null, "persona": persona }),
                min + extra_near,
            )
            .await?;
        if res != Value::Bool(true) {
            return Err(anyhow!("launch of {label} failed: {res}"));
        }
        Ok(format!("{label}.{}", self.launchpad).parse()?)
    }

    /// Deploy a plain NEP-141 token that knows nothing about AutoCTO, with the
    /// whole supply at `owner`. `keyless` deletes its access key, like a token
    /// whose developer has given up control.
    pub async fn deploy_token(
        &mut self,
        name: &str,
        owner: &AccountId,
        supply: u128,
        keyless: bool,
    ) -> Result<AccountId> {
        let id = self.new_account(name, 10).await?;
        Contract::deploy(id.clone())
            .use_code(read_res("mock_ft.wasm")?)
            .with_init_call("new", json!({ "owner": owner, "total_supply": supply.to_string(), "name": name, "symbol": name.to_uppercase() }))?
            .with_signer(self.caller.signer.clone())
            .send_to(&self.caller.net)
            .await?
            .assert_success();
        if keyless {
            let key = self.caller.signer.get_public_key().await?;
            near_api::Account(id.clone())
                .delete_key(key)
                .with_signer(self.caller.signer.clone())
                .send_to(&self.caller.net)
                .await?
                .assert_success();
        }
        Ok(id)
    }

    pub async fn info(&self, coin: &AccountId) -> Result<Value> {
        self.caller.view(coin, "coin_info", json!({})).await
    }

    pub async fn balance(&self, coin: &AccountId, who: &AccountId) -> Result<u128> {
        Ok(u128_of(&self.caller.view(coin, "ft_balance_of", json!({ "account_id": who })).await?))
    }

    /// Advance the chain by this many blocks.
    pub async fn wait_blocks(&self, blocks: u64) -> Result<()> {
        self.sandbox.fast_forward(blocks).await?;
        Ok(())
    }

    /// Advance block time by at least `secs` (a fast-forwarded block adds ~0.3 s).
    pub async fn wait_secs(&self, secs: u64) -> Result<()> {
        self.wait_blocks(secs * 10 / 3 + 10).await
    }

    /// Resolve every pending brain run once. Returns the brain outputs.
    pub async fn work(&self) -> Result<Vec<Value>> {
        self.answer(None).await
    }

    /// Resolve every pending brain run with the real brain, or with a forced
    /// answer (to see what the contract does with a lying brain).
    async fn answer(&self, forced: Option<&Value>) -> Result<Vec<Value>> {
        let pending = self.caller.view(&self.outlayer, "list_pending", json!({})).await?;
        let mut outs = vec![];
        for p in pending.as_array().cloned().unwrap_or_default() {
            let id = p["request_id"].as_u64().unwrap_or(0);
            let input = p["input_data"].as_str().unwrap_or("{}").to_string();
            let out = match forced {
                Some(v) => v.clone(),
                None => {
                    let mut env = autocto_brain::Env::from_process();
                    env.rpc_url = Some(self.rpc_url());
                    let out = tokio::task::spawn_blocking(move || {
                        autocto_brain::run(&input, &env, &autocto_brain::NativeHttp)
                    })
                    .await?;
                    serde_json::to_value(&out)?
                }
            };
            self.caller
                .ok(&self.worker, &self.outlayer, "resolve", json!({ "request_id": id, "output": out.to_string() }), 0)
                .await?;
            outs.push(out);
        }
        Ok(outs)
    }

    /// Poke a coin's brain and play the OutLayer worker until it answers.
    /// Returns (brain output, decision record).
    pub async fn think(&self, by: &AccountId, coin: &AccountId, deposit: u128) -> Result<(Value, Value)> {
        self.think_answered(by, coin, deposit, None).await
    }

    /// Like `think`, but OutLayer returns `forced` instead of running the brain.
    pub async fn think_forced(
        &self,
        by: &AccountId,
        coin: &AccountId,
        deposit: u128,
        forced: Value,
    ) -> Result<(Value, Value)> {
        self.think_answered(by, coin, deposit, Some(forced)).await
    }

    async fn think_answered(
        &self,
        by: &AccountId,
        coin: &AccountId,
        deposit: u128,
        forced: Option<Value>,
    ) -> Result<(Value, Value)> {
        let caller = self.caller.clone();
        let (by2, coin2) = (by.clone(), coin.clone());
        let task = tokio::spawn(async move { caller.call(&by2, &coin2, "think", json!({}), deposit).await });
        let mut outs = vec![];
        for _ in 0..60 {
            tokio::time::sleep(Duration::from_millis(500)).await;
            outs = self.answer(forced.as_ref()).await?;
            if !outs.is_empty() {
                break;
            }
        }
        let r = task.await??;
        if r.is_failure() {
            return Err(anyhow!("think failed: {:?}", r.logs()));
        }
        let info = self.info(coin).await?;
        let last = info["decisions"].as_u64().unwrap_or(1) - 1;
        let decision = self.caller.view(coin, "get_decision", json!({ "id": last })).await?;
        Ok((outs.pop().unwrap_or(Value::Null), decision))
    }
}

// ---------- shared by the deploy, keeper and relayer binaries ----------

/// The value after `name` on the command line.
pub fn arg(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned()
}

/// `--network testnet` (the default) or an RPC URL; returns the config and the
/// name its config file and credentials go by. `tool` never runs on mainnet.
pub fn network_arg(args: &[String], tool: &str) -> Result<(NetworkConfig, &'static str)> {
    match arg(args, "--network").as_deref().unwrap_or("testnet") {
        "testnet" => Ok((NetworkConfig::testnet(), "testnet")),
        "mainnet" => Err(anyhow!("the {tool} does not run on mainnet")),
        url => Ok((NetworkConfig::from_rpc_url("custom", url.parse()?), "local")),
    }
}

/// `--launchpad`, or else the launchpad in web/config.<network>.json.
pub fn launchpad_arg(args: &[String], net_name: &str) -> Result<AccountId> {
    if let Some(l) = arg(args, "--launchpad") {
        return Ok(l.parse()?);
    }
    let path = res_dir().join(format!("../web/config.{net_name}.json"));
    let text = std::fs::read_to_string(&path).with_context(|| format!("no --launchpad and no {}", path.display()))?;
    let cfg: Value = serde_json::from_str(&text)?;
    Ok(cfg["launchpad"].as_str().context("config has no launchpad")?.parse()?)
}

/// The signing key for `owner`: NEAR_PRIVATE_KEY, or else the near-cli
/// credentials file ~/.near-credentials/<network>/<owner>.json.
pub fn load_signer(network: &str, owner: &AccountId) -> Result<Arc<Signer>> {
    match std::env::var("NEAR_PRIVATE_KEY") {
        Ok(k) if !k.is_empty() => Ok(Signer::from_secret_key(k.trim().parse()?)?),
        _ => {
            let home = std::env::var("HOME").context("HOME is not set")?;
            let path = PathBuf::from(home).join(format!(".near-credentials/{network}/{owner}.json"));
            Signer::from_access_keyfile(path.clone())
                .map_err(|e| anyhow!("no NEAR_PRIVATE_KEY and cannot read {}: {e}", path.display()))
        }
    }
}

pub fn sha256_hex(data: &[u8]) -> String {
    near_api::types::CryptoHash::hash(data).0.iter().map(|b| format!("{b:02x}")).collect()
}
