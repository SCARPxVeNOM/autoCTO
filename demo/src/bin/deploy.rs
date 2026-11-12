//! Deploy the launchpad to testnet (or any RPC) with fixed rules and a brain
//! pinned by hash. Nothing here runs on mainnet.
//!
//!   cargo run -p autocto-demo --bin deploy -- --owner you.testnet --brain-url <FastFS URL> [--global] [--lock]
//!
//!   --owner <account>        signs and pays; the launchpad becomes autocto.<owner>
//!   --launchpad <account>    a different sub-account of --owner
//!   --network <testnet|url>  default testnet; an RPC URL needs --outlayer
//!   --outlayer <account>     default outlayer.testnet
//!   --params <file>          default params/testnet.json
//!   --brain-url <url>        where OutLayer fetches res/autocto-brain.wasm (`outlayer upload`)
//!   --brain-project <id>     instead: an OutLayer project "owner/name" (needed for secrets)
//!   --brain-version <key>    project version to pin (default: sha256 of res/autocto-brain.wasm)
//!   --secrets-profile <name> with --brain-project: hand the brain that secrets profile of --owner
//!   --global                 publish the coin code once by hash, so launches skip ~4.3 NEAR of storage
//!   --fund <NEAR>            launchpad starting balance (default 8)
//!   --top-up <NEAR>          the launchpad account exists already: send it this much and deploy
//!   --lock                   delete the launchpad's only key at the end: no one can change it again
//!   --web-config <file>      where to write the page config (default web/config.testnet.json)
//!
//! The signing key comes from NEAR_PRIVATE_KEY, or else from the near-cli
//! credentials file ~/.near-credentials/<network>/<owner>.json.

use std::path::PathBuf;

use anyhow::{Context, Result, anyhow, bail};
use autocto_demo::{ONE_NEAR, arg, load_signer, read_res, res_dir, sha256_hex, u128_of};
use near_api::{Account, AccountId, Contract, CryptoHash, NearToken, NetworkConfig};
use serde_json::{Value, json};

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let flag = |name: &str| args.iter().any(|a| a == name);
    let owner: AccountId = arg(&args, "--owner").context("--owner <account> is required")?.parse()?;
    let network = arg(&args, "--network").unwrap_or_else(|| "testnet".into());
    let (net, net_name, default_outlayer) = match network.as_str() {
        "testnet" => (NetworkConfig::testnet(), "testnet", Some("outlayer.testnet")),
        "mainnet" => bail!("this tool does not deploy to mainnet"),
        url => (NetworkConfig::from_rpc_url("custom", url.parse()?), "custom", None),
    };
    let outlayer: AccountId = arg(&args, "--outlayer")
        .or(default_outlayer.map(String::from))
        .context("--outlayer is required with a custom RPC")?
        .parse()?;
    let launchpad: AccountId = arg(&args, "--launchpad").unwrap_or_else(|| format!("autocto.{owner}")).parse()?;
    if !launchpad.is_sub_account_of(&owner) {
        bail!("{launchpad} must be a sub-account of {owner}");
    }

    let signer = load_signer(net_name, &owner)?;
    let public_key = signer.get_public_key().await?;

    // Rules and brain are fixed at deploy time; the launchpad has no setters.
    let params_path = arg(&args, "--params").unwrap_or_else(|| "params/testnet.json".into());
    let params: Value =
        serde_json::from_str(&std::fs::read_to_string(&params_path).with_context(|| params_path.clone())?)?;
    let brain_wasm = read_res("autocto-brain.wasm")?;
    let brain_sha = sha256_hex(&brain_wasm);
    let source = match (arg(&args, "--brain-url"), arg(&args, "--brain-project")) {
        (Some(url), None) => json!({ "WasmUrl": { "url": url, "hash": brain_sha, "build_target": "wasm32-wasip2" } }),
        (None, Some(project)) => json!({ "Project": {
            "project_id": project,
            "version_key": arg(&args, "--brain-version").unwrap_or_else(|| brain_sha.clone()),
        } }),
        _ => bail!("pass exactly one of --brain-url or --brain-project"),
    };
    let secrets_ref = match arg(&args, "--secrets-profile") {
        Some(profile) if source.get("Project").is_some() => {
            Some(json!({ "profile": profile, "account_id": owner }).to_string())
        }
        Some(_) => bail!("--secrets-profile needs --brain-project (OutLayer only passes secrets to projects)"),
        None => None,
    };
    let brain = json!({
        "outlayer": outlayer,
        "source": source.to_string(),
        "secrets_ref": secrets_ref,
        "max_instructions": 10_000_000_000u64,
    });

    let coin_code = read_res("autocto_coin.wasm")?;
    let code_mode = if flag("--global") {
        println!("publishing the coin code as a global contract ({} bytes)…", coin_code.len());
        Contract::deploy_global_contract_code(coin_code.clone())
            .as_hash()
            .with_signer(owner.clone(), signer.clone())
            .send_to(&net)
            .await?
            .assert_success();
        json!({ "Global": { "code_hash": CryptoHash::hash(&coin_code).to_string() } })
    } else {
        json!("Embedded")
    };

    let fund: u128 = arg(&args, "--fund").map(|n| n.parse::<u128>()).transpose()?.unwrap_or(8);
    if let Some(extra) = arg(&args, "--top-up") {
        // The account exists already (an earlier run ran out of balance): add to it instead.
        let extra: NearToken = format!("{extra} NEAR").parse().map_err(|e| anyhow!("--top-up: {e}"))?;
        println!("sending {extra} to {launchpad}…");
        near_api::Tokens::account(owner.clone())
            .send_to(launchpad.clone())
            .near(extra)
            .with_signer(signer.clone())
            .send_to(&net)
            .await?
            .assert_success();
    } else {
        println!("creating {launchpad} with {fund} NEAR…");
        Account::create_account(launchpad.clone())
            .fund_myself(owner.clone(), NearToken::from_near(fund))
            .with_public_key(public_key)
            .with_signer(signer.clone())
            .send_to(&net)
            .await?
            .assert_success();
    }

    println!("deploying the launchpad…");
    Contract::deploy(launchpad.clone())
        .use_code(read_res("autocto_launchpad.wasm")?)
        .with_init_call("new", json!({ "params": params, "brain": brain, "code_mode": code_mode }))?
        .with_signer(signer.clone())
        .send_to(&net)
        .await?
        .assert_success();

    let view = |method: &'static str| {
        let net = net.clone();
        let launchpad = launchpad.clone();
        async move {
            Contract(launchpad)
                .call_function(method, json!({}))
                .read_only::<Value>()
                .fetch_from(&net)
                .await
                .map(|d| d.data)
                .map_err(|e| anyhow!("{method}: {e}"))
        }
    };
    if view("get_params").await? != params {
        bail!("the deployed rules differ from {params_path}");
    }
    let min = u128_of(&view("min_launch_deposit").await?);

    if flag("--lock") {
        println!("deleting the launchpad's only key…");
        Account(launchpad.clone())
            .delete_key(public_key)
            .with_signer(signer.clone())
            .send_to(&net)
            .await?
            .assert_success();
    }
    let keys = Account(launchpad.clone()).list_keys().fetch_from(&net).await?.data;

    let rpc = net.rpc_endpoints[0].url.to_string();
    let config_path =
        arg(&args, "--web-config").map(PathBuf::from).unwrap_or_else(|| res_dir().join("../web/config.testnet.json"));
    let cfg = json!({
        "network": net_name,
        "rpc": rpc,
        "launchpad": launchpad,
        "explorer": (net_name == "testnet").then_some("https://testnet.nearblocks.io"),
    });
    std::fs::write(&config_path, serde_json::to_string_pretty(&cfg)? + "\n")?;

    println!("\ndone.");
    println!("  launchpad        {launchpad}");
    println!("  outlayer         {outlayer}");
    println!("  brain sha256     {brain_sha}");
    println!("  coin code        {}", view("coin_code_hash").await?);
    println!("  launch deposit   {:.3} NEAR minimum", min as f64 / ONE_NEAR as f64);
    println!("  access keys      {}", keys.len());
    println!("  page config      {}", config_path.display());
    println!("\nlaunch a coin:");
    println!(
        "  near contract call-function as-transaction {launchpad} launch json-args '{{\"label\":\"pepe\",\"name\":\"Pepe\",\"symbol\":\"PEPE\",\"icon\":null,\"persona\":\"A smug frog.\"}}' prepaid-gas '300 Tgas' attached-deposit '{:.2} NEAR' sign-as {owner} network-config testnet sign-with-legacy-keychain send",
        (min as f64 / ONE_NEAR as f64) + 1.0
    );
    Ok(())
}
