//! The coin's brain: an OutLayer WASM program pinned at launch.
//!
//! `think()` sends the coin's public state to OutLayer; the answer comes back
//! in `on_brain` and is applied only through the same checks a holder's
//! proposal goes through. The brain supplies names and numbers, never code.

use near_sdk::json_types::U128;
use near_sdk::serde_json::{self, Value, json};
use near_sdk::{AccountId, Gas, NearToken, Promise, env, ext_contract, near, require};

use crate::types::*;
use crate::{Coin, CoinExt, hex, truncate};

const GAS_ON_BRAIN: Gas = Gas::from_tgas(80);
const MAX_ANSWER_BYTES: usize = 16_384;

#[ext_contract(ext_outlayer)]
#[allow(dead_code)]
trait OutLayer {
    fn request_execution(
        &mut self,
        source: Value,
        resource_limits: Option<Value>,
        input_data: Option<String>,
        secrets_ref: Option<Value>,
        response_format: Option<String>,
        payer_account_id: Option<AccountId>,
        params: Option<Value>,
    );
}

#[near]
impl Coin {
    /// Poke the brain. Attach at least `brain_fee` to pay for the run yourself;
    /// otherwise the treasury pays, within its daily cap.
    #[payable]
    pub fn think(&mut self) -> Promise {
        self.assert_active();
        let now = self.now();
        require!(
            self.last_think == 0 || now >= self.last_think + self.params.think_cooldown_sec * NS_PER_SEC,
            "the brain is resting (think cooldown)"
        );
        let caller = env::predecessor_account_id();
        let attached = env::attached_deposit().as_yoctonear();
        let fee = self.params.brain_fee.0;
        let (pay, by_treasury) = if attached >= fee {
            (attached, false)
        } else {
            let day = now / DAY_NS;
            if day != self.brain_day {
                self.brain_day = day;
                self.brain_spent_today = 0;
            }
            require!(
                self.brain_spent_today + fee <= self.params.brain_daily_cap.0,
                "the brain budget for today is spent"
            );
            require!(self.treasury() >= fee, "the treasury is too poor to think");
            self.brain_spent_today += fee;
            (fee, true)
        };
        self.brain_spent_total += pay;
        self.last_think = now;

        let id = self.decisions.len() as u64;
        let input = self.brain_input_value(id).to_string();
        let input_sha256 = hex(&env::sha256(input.as_bytes()));
        self.decisions.push(Decision {
            id,
            requested_at: now,
            requested_by: caller.clone(),
            paid: U128(pay),
            paid_by_treasury: by_treasury,
            input_sha256: input_sha256.clone(),
            answered_at: None,
            output: None,
            status: DecisionStatus::Pending,
        });
        let text = format!("{caller} woke the brain (decision #{id})");
        self.emit(
            "think",
            json!({ "decision": id, "by": caller, "paid": U128(pay), "treasury": by_treasury, "input_sha256": input_sha256 }),
            text,
        );

        let source: Value = serde_json::from_str(&self.brain.source).expect("bad brain source");
        let secrets_ref: Option<Value> =
            self.brain.secrets_ref.as_ref().map(|s| serde_json::from_str(s).expect("bad secrets ref"));
        let limits = json!({
            "max_instructions": self.brain.max_instructions,
            "max_memory_mb": 256,
            "max_execution_seconds": 120
        });
        // Leftovers go back to whoever paid.
        let payer = if by_treasury { self.me() } else { caller };
        ext_outlayer::ext(self.brain.outlayer.clone())
            .with_attached_deposit(NearToken::from_yoctonear(pay))
            .with_unused_gas_weight(1)
            .request_execution(
                source,
                Some(limits),
                Some(input),
                secrets_ref,
                Some("Json".to_string()),
                Some(payer),
                None,
            )
            .then(Self::ext(self.me()).with_static_gas(GAS_ON_BRAIN).on_brain(id))
    }

    /// OutLayer's answer. Only reachable as the callback of our own call to the
    /// OutLayer account fixed at launch, so nobody else can feed the brain's voice.
    #[private]
    pub fn on_brain(&mut self, decision_id: u64) -> String {
        let now = self.now();
        let raw = env::promise_result_checked(0, MAX_ANSWER_BYTES).ok();
        let parsed: Option<Result<BrainOutput, String>> = match &raw {
            None => None,
            Some(bytes) if bytes.is_empty() => None,
            Some(bytes) => match serde_json::from_slice::<Value>(bytes) {
                Ok(Value::Null) => None,
                Ok(v) => Some(serde_json::from_value(v).map_err(|e| e.to_string())),
                Err(e) => Some(Err(e.to_string())),
            },
        };
        let output_text = raw.as_ref().map(|b| truncate(String::from_utf8_lossy(b).into_owned(), 2000));

        let (status, summary) = match parsed {
            None => (DecisionStatus::NoAnswer, "no answer from OutLayer".to_string()),
            Some(Err(e)) => (
                DecisionStatus::Refused { reason: truncate(format!("unreadable answer: {e}"), 200) },
                "unreadable answer".to_string(),
            ),
            Some(Ok(out)) => {
                if let Some(thought) = &out.thought {
                    let t = truncate(thought.clone(), 280);
                    self.emit("thought", json!({ "decision": decision_id, "thought": t }), t.clone());
                }
                match self.apply_brain_action(decision_id, out.action) {
                    Ok(desc) => (DecisionStatus::Applied, desc),
                    Err(reason) => {
                        (DecisionStatus::Refused { reason: truncate(reason.clone(), 200) }, reason)
                    }
                }
            }
        };

        if let Some(d) = self.decisions.get_mut(decision_id as u32) {
            d.answered_at = Some(now);
            d.output = output_text;
            d.status = status.clone();
        }
        let text = format!("decision #{decision_id}: {summary}");
        self.emit("decision", json!({ "decision": decision_id, "status": status }), text);
        summary
    }

    /// Exactly what the brain will be given on the next `think()`.
    pub fn brain_input(&self) -> Value {
        self.brain_input_value(self.decisions.len() as u64)
    }
}

impl Coin {
    fn brain_input_value(&self, decision_id: u64) -> Value {
        let network = if self.me().as_str().ends_with(".near") { "mainnet" } else { "testnet" };
        let live: Vec<Offer> = self.list_offers(Some(true));
        json!({
            "version": 1,
            "decision_id": decision_id,
            "coin": self.me(),
            "launchpad": self.launchpad,
            "network": network,
            "now": self.now().to_string(),
            "persona": self.persona,
            "info": self.coin_info(),
            "params": self.params,
            "offers": live,
            "watchlist": self.watchlist,
            "tenders": self.list_tenders(Some(true)),
        })
    }

    fn apply_brain_action(&mut self, decision_id: u64, action: BrainAction) -> Result<String, String> {
        let by = Proposer::Brain { decision_id };
        match action {
            BrainAction::None => Ok("decided to wait".into()),
            BrainAction::Offer { target, rate_ppm, pitch } => {
                let desc = format!("bid for {target}");
                self.try_make_offer(target, rate_ppm.0, pitch, by)?.detach();
                Ok(desc)
            }
            BrainAction::Counter { offer, rate_ppm, pitch } => {
                let desc = format!("countered {offer}");
                self.try_counter(offer, rate_ppm.0, pitch, by)?.detach();
                Ok(desc)
            }
            BrainAction::AcceptCounter { offer_id } => {
                self.try_accept_counter(offer_id)?.detach();
                Ok(format!("accepted the counter on bid #{offer_id}"))
            }
            BrainAction::Tender { token, rate_ppm, pitch } => {
                if !self.watchlist.contains(&token) {
                    return Err(format!("{token} is not on the holders' watchlist"));
                }
                let desc = format!("opened a tender for {token}");
                self.try_open_tender(token, rate_ppm.0, pitch, by)?.detach();
                Ok(desc)
            }
            BrainAction::Stance { offer, support, pitch } => {
                let known = self.incoming.contains_key(&offer)
                    || offer
                        .rsplit_once('#')
                        .and_then(|(_, id)| id.parse::<u64>().ok())
                        .is_some_and(|id| self.outgoing.contains_key(&id));
                if !known {
                    return Err(format!("unknown offer {offer}"));
                }
                let pitch = truncate(pitch, MAX_PITCH_LEN);
                let text = format!(
                    "brain says vote {} on {offer}: \"{pitch}\"",
                    if support { "YES" } else { "NO" }
                );
                self.emit(
                    "stance",
                    json!({ "decision": decision_id, "offer": offer, "support": support, "pitch": pitch }),
                    text,
                );
                Ok(format!("took a stance on {offer}"))
            }
        }
    }
}
