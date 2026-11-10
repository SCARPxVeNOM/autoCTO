//! A gasless relayer for AutoCTO (NEP-366): holders sign lock, vote, veto and
//! claim calls, this service pays the gas. It has no special rights and
//! cannot alter a request; it only forwards a short list of zero-deposit
//! calls to coins of one launchpad (see `autocto_demo::gasless`).
//!
//!   cargo run -p autocto-demo --bin relayer -- --owner you.testnet [--port 3040]
//!
//!   POST /relay   {"signed_delegate_action": "<base64 of the borsh bytes>"}
//!     -> 200 {"ok": true, "result": <the call's return value>}
//!     -> 400 {"ok": false, "error": "<why it was refused or failed>"}
//!
//!   --owner <account>        pays the gas
//!   --network <testnet|url>  default testnet
//!   --launchpad <account>    default: web/config.<network>.json
//!   --port <n>               default 3040 (listens on 127.0.0.1)
//!
//! The key comes from NEAR_PRIVATE_KEY or ~/.near-credentials/<network>/<owner>.json.

use std::sync::Arc;

use anyhow::{Context, Result, bail};
use autocto_demo::gasless::{Relayer, serve_http};
use autocto_demo::{Caller, load_signer, res_dir};
use near_api::{AccountId, NetworkConfig};
use serde_json::Value;

fn arg(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned()
}

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let owner: AccountId = arg(&args, "--owner").context("--owner <account> is required")?.parse()?;
    let network = arg(&args, "--network").unwrap_or_else(|| "testnet".into());
    let (net, net_name) = match network.as_str() {
        "testnet" => (NetworkConfig::testnet(), "testnet"),
        "mainnet" => bail!("this relayer does not run on mainnet"),
        url => (NetworkConfig::from_rpc_url("custom", url.parse()?), "local"),
    };
    let launchpad: AccountId = match arg(&args, "--launchpad") {
        Some(l) => l.parse()?,
        None => {
            let path = res_dir().join(format!("../web/config.{net_name}.json"));
            let cfg: Value = serde_json::from_str(&std::fs::read_to_string(&path).with_context(|| format!("no --launchpad and no {}", path.display()))?)?;
            cfg["launchpad"].as_str().context("config has no launchpad")?.parse()?
        }
    };
    let port: u16 = arg(&args, "--port").and_then(|p| p.parse().ok()).unwrap_or(3040);
    let relayer = Arc::new(Relayer { caller: Caller { net, signer: load_signer(net_name, &owner)? }, account: owner, launchpad });
    println!("gasless relayer for {} paid by {}: POST http://127.0.0.1:{port}/relay", relayer.launchpad, relayer.account);
    serve_http(relayer, port).await
}
