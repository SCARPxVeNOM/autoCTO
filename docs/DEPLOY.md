# Deploy your own launchpad

You need a testnet account with about 8 NEAR for the launchpad (code storage), plus about 7.6 NEAR per coin in the default Embedded mode.

```bash
# 1. A testnet account whose key is saved where the deploy tool reads it
cargo install near-cli-rs --locked
near account create-account sponsor-by-faucet-service <you>.testnet autogenerate-new-keypair save-to-legacy-keychain network-config testnet create

# 2. Deploy the launchpad as autocto.<you>.testnet with params/testnet.json.
#    OutLayer fetches the brain from any https URL and checks its sha256, so the
#    copy committed in res/ works; pin the URL to a commit.
cargo run -p autocto-demo --bin deploy -- --owner <you>.testnet \
  --brain-url https://raw.githubusercontent.com/SCARPxVeNOM/autoCTO/<commit>/res/autocto-brain.wasm --lock

# 3. Open the app on testnet
python3 -m http.server 8080 -d web   # http://localhost:8080/?network=testnet
```

The key comes from `~/.near-credentials/testnet/<you>.testnet.json`, or from `NEAR_PRIVATE_KEY`. The brain can also go to OutLayer's FastFS with `outlayer upload res/autocto-brain.wasm` (OutLayer CLI).

The tool checks the deployed rules against the params file, prints the coin code hash and launch deposit, and writes `web/config.testnet.json`. The app reads the chain through public nodes (FastNEAR, then dRPC) and moves to the next when one refuses. `web/` is a static site with no backend, so any static host can serve it; off localhost it defaults to testnet. The hosted app is Vercel serving `web/` as is, with no build step, plus the optional guest function below.

If the launchpad account runs short of balance for its code storage, the deploy stops after creating it. Re-run with `--top-up <NEAR>` to add to the existing account and deploy.

| Option | Effect |
|---|---|
| `--lock` | deletes the launchpad's only access key, so nobody can change it again |
| `--global` | publishes the coin code once as a global contract. A launch then costs 1.5 NEAR instead of 5.8, but publishing burns about 43 NEAR (10× normal storage), so it only pays off after about 10 coins |
| `--brain-project <you>.testnet/autocto-brain --secrets-profile default` | model mode. OutLayer only passes secrets to projects: first `outlayer deploy autocto-brain <brain URL>`, then `outlayer secrets set '{"NEAR_AI_API_KEY":"…"}' --project <you>.testnet/autocto-brain`, then deploy with these flags instead of `--brain-url` |

## Guest accounts

A visitor with no wallet presses **Try as guest**. The page makes an ed25519 key pair and sends only the public key to [`web/api/guest.js`](../web/api/guest.js), a Vercel function that creates `<random>.<GUEST_ACCOUNT>` with that key and 1 test NEAR. The private key stays in the browser's storage, and every later call is signed there with near-api-js, so the function never sees or holds a guest's key. It hands out one guest per visitor every 20 minutes and keeps a reserve so the funding account never empties.

It is off unless the host sets `GUEST_ACCOUNT` (a funded testnet account) and `GUEST_KEY` (a full-access key for it); `GUEST_NEAR` changes the amount. Without them, or on a plain static host, the page shows **Connect wallet** only. A guest gets less NEAR than a launch takes, so launching a coin still needs a wallet.
