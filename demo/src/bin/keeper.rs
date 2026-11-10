//! The keeper: a small bot that pokes the coins, because a contract only acts
//! when something calls it. Anyone can run one; it has no special rights.
//!
//!   cargo run -p autocto-demo --bin keeper -- --owner you.testnet [--think] [--once]
//!
//! Every round, for every coin of the launchpad, it
//!   - finalizes takeover votes whose period has ended,
//!   - settles tender offers whose deadline has passed,
//!   - with --think, wakes brains that have work to do (the coin's treasury
//!     pays, within its daily cap),
//!   - relays new public events to Telegram when TELEGRAM_BOT_TOKEN and
//!     TELEGRAM_CHAT_ID are set: the coins "talk" in a channel while the
//!     binding offers travel on-chain.
//!
//!   --owner <account>        signs and pays gas
//!   --network <testnet|url>  default testnet
//!   --launchpad <account>    default: web/config.<network>.json
//!   --interval <sec>         pause between rounds (default 30)
//!   --think-every <sec>      at most one thought per coin in this time (default 600)
//!   --once                   one round, then exit
//!
//! The key comes from NEAR_PRIVATE_KEY or ~/.near-credentials/<network>/<owner>.json.

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use anyhow::{Context, Result, bail};
use autocto_brain::Http;
use autocto_demo::{Caller, load_signer, res_dir};
use near_api::{AccountId, NetworkConfig};
use serde_json::{Value, json};

fn arg(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned()
}

fn status_is(v: &Value, name: &str) -> bool {
    v.as_str() == Some(name)
}

/// Events worth a chat message; the rest stay in the on-chain log.
const PUBLIC_EVENTS: [&str; 15] = [
    "born", "thought", "offer_made", "counter", "counter_accepted", "stance", "offer_passed",
    "offer_failed", "takeover", "merged", "nominated", "tender_backed", "tender_opened", "tender_succeeded", "tender_failed",
];

fn telegram(token: &str, chat: &str, text: &str) {
    let url = format!("https://api.telegram.org/bot{token}/sendMessage");
    let body = json!({ "chat_id": chat, "text": text, "disable_web_page_preview": true });
    if let Err(e) = autocto_brain::NativeHttp.post_json(&url, &[], &body.to_string()) {
        // Never print the URL: it holds the bot token.
        eprintln!("  telegram: message not sent ({})", e.split(':').next().unwrap_or("error"));
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let flag = |name: &str| args.iter().any(|a| a == name);
    let owner: AccountId = arg(&args, "--owner").context("--owner <account> is required")?.parse()?;
    let network = arg(&args, "--network").unwrap_or_else(|| "testnet".into());
    let (net, net_name) = match network.as_str() {
        "testnet" => (NetworkConfig::testnet(), "testnet"),
        "mainnet" => bail!("this keeper does not run on mainnet"),
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
    let interval: u64 = arg(&args, "--interval").and_then(|s| s.parse().ok()).unwrap_or(30);
    let think_every: u64 = arg(&args, "--think-every").and_then(|s| s.parse().ok()).unwrap_or(600);
    let c = Caller { net, signer: load_signer(net_name, &owner)? };
    let tg = match (std::env::var("TELEGRAM_BOT_TOKEN"), std::env::var("TELEGRAM_CHAT_ID")) {
        (Ok(t), Ok(chat)) if !t.is_empty() && !chat.is_empty() => Some((t, chat)),
        _ => None,
    };
    println!(
        "keeper for {launchpad} as {owner}: thinking {}, telegram {}",
        if flag("--think") { "on" } else { "off" },
        if tg.is_some() { "on" } else { "off" }
    );

    // Newest event already relayed, per coin. The first round only marks the spot.
    let mut seen: HashMap<AccountId, u64> = HashMap::new();
    let mut first_round = true;
    // Bid states a brain was already woken for: one thought per change, not per round.
    let mut poked: HashSet<String> = HashSet::new();
    loop {
        let coins = c.view(&launchpad, "list_coins", json!({ "limit": 100 })).await?;
        for entry in coins.as_array().into_iter().flatten() {
            if entry["state"] != "Live" {
                continue;
            }
            let coin: AccountId = entry["account_id"].as_str().unwrap_or_default().parse()?;
            let info = c.view(&coin, "coin_info", json!({})).await?;
            let params = c.view(&coin, "get_params", json!({})).await?;
            let now = c.view(&coin, "brain_input", json!({})).await?["now"].as_str().and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);
            let sym = info["symbol"].as_str().unwrap_or("?").to_string();

            // Votes that ended: anyone may finalize.
            let offers = c.view(&coin, "list_offers", json!({ "live_only": true })).await?;
            let mut work = false;
            let mut pending = vec![];
            for o in offers.as_array().into_iter().flatten() {
                let ours = o["target"] == coin.to_string();
                let reveal = params["reveal_period_sec"].as_u64().unwrap_or(0) * 1_000_000_000;
                let ends = o["vote_ends"].as_u64().unwrap_or(u64::MAX).saturating_add(reveal);
                if ours && status_is(&o["status"], "Open") && now >= ends {
                    let key = format!("{}#{}", o["buyer"].as_str().unwrap_or(""), o["id"]);
                    let r = c.call(&owner, &coin, "finalize", json!({ "offer": key }), 0).await?;
                    println!("  ${sym}: finalized {key} -> {}", if r.is_success() { r.json::<Value>().unwrap_or(Value::Null).to_string() } else { "refused".into() });
                } else if status_is(&o["status"], "Open") && (ours || o["counter"].is_object()) {
                    // A new bid for us, new terms, or a counter to one of ours is work for the brain.
                    let state = format!("{coin}|{}#{}|{}|{}", o["buyer"].as_str().unwrap_or(""), o["id"], o["round"], o["counter"].is_object());
                    work |= !poked.contains(&state);
                    pending.push(state);
                }
            }

            // Tenders past their deadline: swap everyone or refund everyone.
            let tenders = c.view(&coin, "list_tenders", json!({ "live_only": true })).await?;
            for t in tenders.as_array().into_iter().flatten() {
                if status_is(&t["status"], "Open") && now >= t["deadline"].as_u64().unwrap_or(u64::MAX) {
                    let r = c.call(&owner, &coin, "settle_tender", json!({ "tender_id": t["id"] }), 0).await?;
                    println!("  ${sym}: settled tender #{} -> {}", t["id"], if r.is_success() { r.json::<Value>().unwrap_or(Value::Null).to_string() } else { "refused".into() });
                }
            }

            // Wake the brain: at once when it has a bid to answer, else every --think-every.
            if flag("--think") && status_is(&info["status"], "Active") {
                let last = info["last_think"].as_u64().unwrap_or(0);
                let cooldown = params["think_cooldown_sec"].as_u64().unwrap_or(0) * 1_000_000_000;
                let due = if work { cooldown } else { cooldown.max(think_every * 1_000_000_000) };
                if now >= last + due {
                    let r = c.call(&owner, &coin, "think", json!({}), 0).await?;
                    poked.extend(pending);
                    println!("  ${sym}: think -> {}", if r.is_success() { r.json::<Value>().unwrap_or(Value::Null).to_string() } else { "refused (cooldown or treasury cap)".into() });
                }
            }

            // Relay new public events.
            let history = c.view(&coin, "history", json!({})).await?;
            let mark = seen.get(&coin).copied().unwrap_or(0);
            let mut newest = mark;
            for e in history.as_array().into_iter().flatten() {
                let at = e["at"].as_u64().unwrap_or(0);
                newest = newest.max(at);
                let event = e["event"].as_str().unwrap_or("");
                if first_round || at <= mark || !PUBLIC_EVENTS.contains(&event) {
                    continue;
                }
                let line = format!("${sym} [{event}] {}", e["text"].as_str().unwrap_or(""));
                println!("  {line}");
                if let Some((token, chat)) = &tg {
                    let (token, chat, line) = (token.clone(), chat.clone(), line.clone());
                    tokio::task::spawn_blocking(move || telegram(&token, &chat, &line)).await?;
                }
            }
            seen.insert(coin, newest);
        }
        if flag("--once") {
            return Ok(());
        }
        first_round = false;
        tokio::time::sleep(Duration::from_secs(interval)).await;
    }
}
