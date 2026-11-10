//! Invariant fuzzing in a local NEAR sandbox: holders take random actions
//! (most of them refused), and after every step the rules that must never
//! break are checked on every coin.
//!
//! FUZZ_SEED and FUZZ_STEPS change the run; a failure prints both.

use anyhow::Result;
use autocto_demo::{ONE_NEAR, ONE_TOKEN, World, demo_params, u128_of};
use near_api::AccountId;
use serde_json::{Value, json};

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        self.0 >> 33
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
    fn pick<'a, T>(&mut self, xs: &'a [T]) -> &'a T {
        &xs[self.below(xs.len() as u64) as usize]
    }
}

struct Fuzz {
    w: World,
    coins: Vec<AccountId>,
    actors: Vec<AccountId>,
    old: AccountId,
    old_supply: u128,
    initial_supply: u128,
    virtual_near: u128,
    reserve: u128,
}

impl Fuzz {
    async fn check(&self, step: &str) -> Result<()> {
        let old_total: u128 = {
            let mut sum = 0;
            for who in self.actors.iter().chain(self.coins.iter()) {
                sum += self.w.balance(&self.old, who).await.unwrap_or(0);
            }
            sum
        };
        assert_eq!(old_total, self.old_supply, "[{step}] outside tokens were created or lost");

        for coin in &self.coins {
            let i = self.w.info(coin).await?;
            let supply = u128_of(&i["total_supply"]);
            let own = self.w.balance(coin, coin).await?;

            // 1. The coin's own account holds exactly the curve inventory plus the locks.
            assert_eq!(own, u128_of(&i["amm_tokens"]) + u128_of(&i["total_locked"]), "[{step}] {coin}: curve + locks");

            // 2. Every token is in a holder's balance, a lock or the curve.
            let mut held = own;
            for who in &self.actors {
                held += self.w.balance(coin, who).await?;
            }
            assert_eq!(held, supply, "[{step}] {coin}: balances do not add up to the supply");

            // 3. Supply changes only through approved mints and burns:
            //    conversions of absorbed coins and claims of succeeded tenders.
            let absorbed = i["absorbed"].as_array().cloned().unwrap_or_default();
            let mut minted_max = 0u128;
            for a in &absorbed {
                let cap = u128_of(&a[1]["max_target_amount"]);
                assert!(u128_of(&a[1]["converted"]) <= cap, "[{step}] {coin}: converted more than was absorbed");
                minted_max += cap * u128_of(&a[1]["rate_ppm"]) / 1_000_000;
            }
            let tenders = self.w.caller.view(coin, "list_tenders", json!({})).await?;
            for t in tenders.as_array().into_iter().flatten() {
                let deposited = u128_of(&t["deposited"]);
                assert!(deposited <= u128_of(&t["max_deposit"]) || t["status"] == "Opening", "[{step}] {coin}: tender over its cap");
                assert!(u128_of(&t["claimed"]) <= deposited, "[{step}] {coin}: tender claims exceed deposits");
                if t["status"] == "Succeeded" {
                    let mint = deposited * u128_of(&t["rate_ppm"]) / 1_000_000;
                    // 4. One tender never dilutes above its cap (20% of supply at the snapshot).
                    assert!(mint <= u128_of(&t["buyer_supply"]) / 5, "[{step}] {coin}: tender dilution cap");
                    minted_max += mint;
                }
            }
            let merged = i["status"].get("Merged").is_some();
            if merged {
                assert!(supply <= self.initial_supply + minted_max, "[{step}] {coin}: supply grew after merging");
            } else {
                assert!(supply >= self.initial_supply, "[{step}] {coin}: tokens were burned on an active coin");
                assert!(supply <= self.initial_supply + minted_max, "[{step}] {coin}: unapproved mint");
            }

            // 5. Solvency: the account always holds the curve's real NEAR and the reserve.
            let curve_real = u128_of(&i["amm_near"]) - self.virtual_near;
            let near = self.w.caller.near_balance(coin).await?;
            assert!(near >= curve_real + self.reserve, "[{step}] {coin}: cannot pay out its curve");

            // 6. A merged coin is convert-only: its curve is closed and its treasury moved.
            if merged {
                assert_eq!(curve_real, 0, "[{step}] {coin}: merged coin still has curve NEAR");
            }
        }
        Ok(())
    }
}

#[tokio::test]
async fn random_actions_never_break_the_rules() -> Result<()> {
    let seed: u64 = std::env::var("FUZZ_SEED").ok().and_then(|s| s.parse().ok()).unwrap_or(20261110);
    let steps: u64 = std::env::var("FUZZ_STEPS").ok().and_then(|s| s.parse().ok()).unwrap_or(90);
    println!("FUZZ_SEED={seed} FUZZ_STEPS={steps}");
    let mut rng = Rng(seed);

    let params = demo_params();
    let mut w = World::start(params.clone(), false, None).await?;
    let dev = w.new_account("dev", 100).await?;
    let mut actors = vec![];
    for name in ["alice", "bob", "carol", "dave"] {
        actors.push(w.new_account(name, 300).await?);
    }
    let mut coins = vec![];
    for (label, extra) in [("pepe", 2), ("doge", 1), ("wojak", 1)] {
        coins.push(w.launch(&dev, label, label, &label.to_uppercase(), "fuzz", extra * ONE_NEAR).await?);
    }
    let old_supply = 1_000_000_000 * ONE_TOKEN;
    let old = w.deploy_token("old", &actors[3], old_supply, true).await?;
    let f = Fuzz {
        w,
        coins,
        actors,
        old,
        old_supply,
        initial_supply: u128_of(&params["total_supply"]),
        virtual_near: u128_of(&params["virtual_near"]),
        reserve: u128_of(&params["reserve"]),
    };
    let c = f.w.caller.clone();

    // Everyone starts with some of every coin, so votes and vetoes can happen.
    for (k, who) in f.actors.iter().enumerate() {
        for (j, coin) in f.coins.iter().enumerate() {
            c.ok(who, coin, "buy", json!({}), (2 + ((k + j) % 3) as u128 * 4) * ONE_NEAR).await?;
            let bal = f.w.balance(coin, who).await?;
            c.ok(who, coin, "lock", json!({ "amount": (bal / 2).to_string() }), 0).await?;
        }
    }
    f.w.wait_secs(31).await?;
    f.check("setup").await?;

    let mut accepted = 0;
    let mut tally = std::collections::BTreeMap::<&str, u32>::new();
    for step in 0..steps {
        let who = rng.pick(&f.actors).clone();
        let coin = rng.pick(&f.coins).clone();
        let other = rng.pick(&f.coins).clone();
        let bal = f.w.balance(&coin, &who).await?;
        let offers = c.view(&coin, "list_offers", json!({ "live_only": true })).await?;
        let offer = offers.as_array().and_then(|o| o.first()).cloned();
        let tender_id = rng.below(3);
        // With a live bid on the table, half the steps are votes, vetoes and finalizes,
        // so runs reach merges and conversions.
        let kind = if offer.is_some() && rng.below(2) == 0 { 6 + rng.below(3) } else { rng.below(15) };
        let (name, r) = match kind {
            0 => ("buy", c.call(&who, &coin, "buy", json!({}), (1 + rng.below(4) as u128) * ONE_NEAR).await?),
            1 => ("sell", c.call(&who, &coin, "sell", json!({ "amount": (bal / (1 + rng.below(4) as u128)).to_string() }), 1).await?),
            2 => ("lock", c.call(&who, &coin, "lock", json!({ "amount": (bal / 2).to_string() }), 0).await?),
            3 => {
                let locked = u128_of(&c.view(&coin, "locks_of", json!({ "account_id": who })).await?[0]["amount"]);
                ("unlock", c.call(&who, &coin, "unlock", json!({ "amount": (locked / 2).max(1).to_string() }), 0).await?)
            }
            4 | 5 => {
                // A bid at a random premium, sometimes outside the caps.
                let p = |i: &Value| u128_of(&i["amm_near"]) as f64 / u128_of(&i["amm_tokens"]) as f64;
                let fair = p(&f.w.info(&other).await?) / p(&f.w.info(&coin).await?) * 1e6;
                let rate = (fair * (0.6 + rng.below(90) as f64 / 100.0)) as u128;
                ("propose_offer", c.call(&who, &coin, "propose_offer", json!({ "target": other, "rate_ppm": rate.to_string(), "pitch": "fuzz" }), 0).await?)
            }
            6 | 7 => match &offer {
                Some(o) if o["target"] == coin.to_string() => {
                    let key = format!("{}#{}", o["buyer"].as_str().unwrap(), o["id"]);
                    ("vote", c.call(&who, &coin, "vote", json!({ "offer": key, "support": rng.below(4) > 0 }), 0).await?)
                }
                Some(o) => ("veto", c.call(&who, &coin, "veto", json!({ "offer_id": o["id"] }), 0).await?),
                None => continue,
            },
            8 => match &offer {
                Some(o) if o["target"] == coin.to_string() => {
                    f.w.wait_secs(61).await?;
                    let key = format!("{}#{}", o["buyer"].as_str().unwrap(), o["id"]);
                    ("finalize", c.call(&who, &coin, "finalize", json!({ "offer": key }), 0).await?)
                }
                _ => continue,
            },
            9 => ("convert", c.call(&who, &coin, "convert", json!({}), 1).await?),
            10 => {
                let circ = u128_of(&f.w.info(&coin).await?["circulating"]);
                let rate = (circ / (5 + rng.below(40) as u128)) * 1_000_000 / (old_supply / 10 * 4);
                ("propose_tender", c.call(&who, &coin, "propose_tender", json!({ "token": f.old, "rate_ppm": rate.max(1).to_string(), "pitch": "fuzz" }), 0).await?)
            }
            12 => ("back_tender", c.call(&who, &coin, "back_tender", json!({ "tender_id": tender_id }), 0).await?),
            11 => {
                let have = f.w.balance(&f.old, &who).await?;
                let amount = have / (1 + rng.below(3) as u128);
                ("tender_deposit", c.call(&who, &f.old, "ft_transfer_call", json!({ "receiver_id": coin, "amount": amount.max(1).to_string(), "msg": tender_id.to_string() }), 1).await?)
            }
            13 => {
                f.w.wait_secs(61).await?;
                ("settle_tender", c.call(&who, &coin, "settle_tender", json!({ "tender_id": tender_id }), 0).await?)
            }
            _ => ("claim_tender", c.call(&who, &coin, "claim_tender", json!({ "tender_id": tender_id }), 0).await?),
        };
        if r.is_success() {
            accepted += 1;
            *tally.entry(name).or_default() += 1;
        }
        f.check(&format!("seed {seed} step {step}: {who} {name} on {coin}")).await?;
    }
    println!("{accepted} of {steps} random actions were accepted; every invariant held after each one");
    println!("accepted by kind: {tally:?}");
    assert!(accepted > steps / 5, "the fuzz run barely did anything: {accepted}/{steps}");
    Ok(())
}
