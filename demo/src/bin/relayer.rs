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

use anyhow::{Context, Result};
use autocto_demo::gasless::{Relayer, serve_http};
use autocto_demo::{Caller, arg, launchpad_arg, load_signer, network_arg};
use near_api::AccountId;

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let owner: AccountId = arg(&args, "--owner").context("--owner <account> is required")?.parse()?;
    let (net, net_name) = network_arg(&args, "relayer")?;
    let launchpad = launchpad_arg(&args, net_name)?;
    let port: u16 = arg(&args, "--port").and_then(|p| p.parse().ok()).unwrap_or(3040);
    let relayer =
        Arc::new(Relayer { caller: Caller { net, signer: load_signer(net_name, &owner)? }, account: owner, launchpad });
    println!(
        "gasless relayer for {} paid by {}: POST http://127.0.0.1:{port}/relay",
        relayer.launchpad, relayer.account
    );
    serve_http(relayer, port).await
}
