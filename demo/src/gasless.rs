//! Gasless actions (NEP-366 meta transactions): a holder signs the action, a
//! relayer wraps it in its own transaction and pays the gas. The action still
//! runs as the holder, so a holder with zero NEAR can lock, vote and veto.
//!
//! The relayer is not trusted with anything: it cannot change what was signed,
//! and it only forwards a short list of zero-deposit calls to launchpad coins.

use std::sync::Arc;

use anyhow::{Context, Result, anyhow, bail};
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use near_api::types::Action;
use near_api::types::transaction::delegate_action::SignedDelegateAction;
use near_api::types::transaction::result::ExecutionFinalResult;
use near_api::{AccountId, Contract, NearGas, Transaction};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use crate::Caller;

/// Calls a relayer forwards. All of them move no NEAR out of the holder.
pub const GASLESS_METHODS: [&str; 9] =
    ["lock", "unlock", "vote", "vote_sealed", "reveal_vote", "veto", "back_tender", "veto_tender", "claim_tender"];
const MAX_GAS_TGAS: u64 = 150;
const MAX_BODY: usize = 64 * 1024;

/// Sign `contract.method(args)` as `from` without sending it. The result goes
/// to a relayer, as base64 of the borsh bytes (`encode`).
pub async fn sign(
    c: &Caller,
    from: &AccountId,
    contract: &AccountId,
    method: &str,
    args: Value,
    deposit_yocto: u128,
) -> Result<SignedDelegateAction> {
    Contract(contract.clone())
        .call_function(method, args)
        .transaction()
        .deposit(near_api::NearToken::from_yoctonear(deposit_yocto))
        .gas(NearGas::from_tgas(100))
        .with_signer(from.clone(), c.signer.clone())
        .meta()
        .presign_with(&c.net)
        .await
        .map_err(|e| anyhow!("sign {method}: {e}"))?
        .transaction
        .signed()
        .ok_or_else(|| anyhow!("{method} was not signed"))
}

pub fn encode(signed: &SignedDelegateAction) -> Result<String> {
    Ok(STANDARD.encode(borsh::to_vec(signed)?))
}

pub fn decode(b64: &str) -> Result<SignedDelegateAction> {
    Ok(borsh::from_slice(&STANDARD.decode(b64.trim())?)?)
}

pub struct Relayer {
    pub caller: Caller,
    /// Pays the gas.
    pub account: AccountId,
    pub launchpad: AccountId,
}

impl Relayer {
    /// Refuse anything that is not a plain, allowed call on a launchpad coin.
    pub async fn check(&self, signed: &SignedDelegateAction) -> Result<()> {
        let d = &signed.delegate_action;
        let is_coin = self.caller.view(&self.launchpad, "is_coin", json!({ "account_id": d.receiver_id })).await?;
        if is_coin != Value::Bool(true) {
            bail!("{} is not a coin of {}", d.receiver_id, self.launchpad);
        }
        let [action] = d.actions.as_slice() else { bail!("exactly one action per request") };
        let Action::FunctionCall(call) = &**action else { bail!("only function calls are relayed") };
        if !GASLESS_METHODS.contains(&call.method_name.as_str()) {
            bail!("`{}` is not relayed; allowed: {}", call.method_name, GASLESS_METHODS.join(", "));
        }
        if call.deposit.as_yoctonear() > 0 {
            bail!("calls with a deposit are not relayed");
        }
        if call.gas.as_tgas() > MAX_GAS_TGAS {
            bail!("too much gas requested");
        }
        Ok(())
    }

    /// Check the request, wrap it and pay for it.
    pub async fn relay(&self, signed: SignedDelegateAction) -> Result<ExecutionFinalResult> {
        self.check(&signed).await?;
        let sender = signed.delegate_action.sender_id.clone();
        let r = Transaction::construct(self.account.clone(), sender)
            .add_action(Action::Delegate(Box::new(signed)))
            .with_signer(self.caller.signer.clone())
            .send_to(&self.caller.net)
            .await
            .map_err(|e| anyhow!("relay: {e}"))?;
        r.into_full().ok_or_else(|| anyhow!("relay: transaction still pending"))
    }
}

// ---------- the relayer as a small HTTP service ----------

async fn handle(relayer: &Relayer, body: &str) -> Result<Value> {
    let req: Value = serde_json::from_str(body).context("body must be JSON")?;
    let b64 = req["signed_delegate_action"].as_str().context("missing signed_delegate_action")?;
    let signed = decode(b64).context("not a signed delegate action")?;
    let who = signed.delegate_action.sender_id.clone();
    let r = relayer.relay(signed).await?;
    let failures = r.receipt_failures();
    if r.is_failure() || !failures.is_empty() {
        // The contract's own refusal, e.g. "already voted in this round".
        let text = format!("{failures:?}");
        let reason = text.split("Smart contract panicked: ").nth(1).and_then(|s| s.split("\\\"").next()).unwrap_or("the call failed").to_string();
        bail!("{reason}");
    }
    println!("  relayed a call for {who}");
    Ok(r.json::<Value>().unwrap_or(Value::Null))
}

async fn serve(mut stream: TcpStream, relayer: Arc<Relayer>) -> Result<()> {
    // Read the head, then exactly content-length bytes of body.
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    let head_end = loop {
        let n = stream.read(&mut chunk).await?;
        if n == 0 {
            return Ok(());
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break i + 4;
        }
        if buf.len() > MAX_BODY {
            return Ok(());
        }
    };
    let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
    let request_line = head.lines().next().unwrap_or("");
    let length: usize = head
        .lines()
        .find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse().unwrap_or(0)))
        .unwrap_or(0)
        .min(MAX_BODY);
    while buf.len() < head_end + length {
        let n = stream.read(&mut chunk).await?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
    }
    let body = String::from_utf8_lossy(&buf[head_end..]).to_string();

    let (status, payload) = if request_line.starts_with("OPTIONS ") {
        ("204 No Content", String::new())
    } else if request_line.starts_with("POST /relay") {
        match handle(&relayer, &body).await {
            Ok(result) => ("200 OK", json!({ "ok": true, "result": result }).to_string()),
            Err(e) => ("400 Bad Request", json!({ "ok": false, "error": format!("{e:#}") }).to_string()),
        }
    } else if request_line.starts_with("GET /") {
        ("200 OK", json!({ "ok": true, "relayer": relayer.account, "launchpad": relayer.launchpad, "methods": GASLESS_METHODS }).to_string())
    } else {
        ("404 Not Found", json!({ "ok": false, "error": "POST /relay" }).to_string())
    };
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Headers: content-type\r\nAccess-Control-Allow-Methods: POST, GET, OPTIONS\r\nConnection: close\r\n\r\n{payload}",
        payload.len()
    );
    stream.write_all(response.as_bytes()).await?;
    Ok(())
}

/// Listen on 127.0.0.1:`port` and relay every valid POST /relay.
pub async fn serve_http(relayer: Arc<Relayer>, port: u16) -> Result<()> {
    let listener = TcpListener::bind(("127.0.0.1", port)).await?;
    loop {
        let (stream, _) = listener.accept().await?;
        let relayer = relayer.clone();
        tokio::spawn(async move {
            if let Err(e) = serve(stream, relayer).await {
                eprintln!("  connection error: {e}");
            }
        });
    }
}
