# Earlier testnet deployments

The current deployment is `v4`: see [Live on testnet](../README.md#live-on-testnet). Every launchpad below is locked (0 access keys) and still on chain, running the code of the commit named.

| Launchpad | Code | Brain | What ran |
|---|---|---|---|
| [`v3.scarpxvenom.testnet`](#v3-the-first-model-mode-takeovers) | `37ad97c` | model mode, signatures checked by the page only | two model-decided takeovers, one with a contested vote and a late buyer |
| [`v2.scarpxvenom.testnet`](#v2-rules-mode-brain) | `493e23f` | rules mode | a takeover with an accepted counter; a tender for a meme.cooking token |
| [`autocto.scarpxvenom.testnet`](#autocto-the-first-launchpad) | `1290ae4` | — | the first brain run through `outlayer.testnet` |

## v3: the first model-mode takeovers

`v3` runs the code at commit `37ad97c`, from before the on-chain signature check: its decisions carry the signature, which the page checks, but the contract does not.

| | |
|---|---|
| Launchpad | [`v3.scarpxvenom.testnet`](https://testnet.nearblocks.io/address/v3.scarpxvenom.testnet), current code, deployed from commit `37ad97c`, locked: 0 access keys |
| Rules | `params/testnet.json` (10-minute votes, 5-minute newborn protection) |
| Brain | OutLayer project `scarpxvenom.testnet/autocto-brain` on `outlayer.testnet`, version pinned by sha256 `ac781f9f…19dbb58` (`res/autocto-brain.wasm` at commit `37ad97c`). **Model mode**: `z-ai/glm-5.3-flash` on NEAR AI Cloud, the API key held as an OutLayer secret |
| Coins | [`pepe.v3.scarpxvenom.testnet`](https://testnet.nearblocks.io/address/pepe.v3.scarpxvenom.testnet), [`doge.v3.scarpxvenom.testnet`](https://testnet.nearblocks.io/address/doge.v3.scarpxvenom.testnet) and [`wojak.v3.scarpxvenom.testnet`](https://testnet.nearblocks.io/address/wojak.v3.scarpxvenom.testnet) (both absorbed), each with 0 access keys |
| Page | `python3 -m http.server 8080 -d web`, then http://localhost:8080/?network=testnet |

**A takeover decided by a model, with each answer signed.** Both brains ran inside OutLayer's TEE and asked a model that NEAR AI runs inside its own TEE. Every model decision below carries NEAR AI's signature on chain (`attest` in `get_decision`), and the page's proof dialog verified each one in the browser.

| Step | What happened | Transaction |
|---|---|---|
| 1 | PEPE's brain is woken with no target yet. The model waits: "DOGE not biddable and equal size". First signed answer on chain | [`7wJ1KNfi…`](https://testnet.nearblocks.io/txns/7wJ1KNfiHSTGYAA4bXBv5BuP9BzyrDs4tiCUNUxBPoBW) |
| 2 | After newborn protection, PEPE's brain bids for DOGE at +5% over the fair rate. OutLayer ran 2.7M instructions in 4.7 s and charged 0.0015 NEAR | [`6aMGvWMv…`](https://testnet.nearblocks.io/txns/6aMGvWMvzjwwLhXSeFLmyVKpLtB1ej5q5mVK1MCz3giD) |
| 3 | DOGE's brain is woken. Its reader marks PEPE's pitch friendly, not an instruction, and the model counters at the +30% cap | [`F5bXcM5F…`](https://testnet.nearblocks.io/txns/F5bXcM5FMkojtAV2VbspxJJj8QCYbYMyubhdaQwJMBBo) |
| 4 | PEPE's brain is woken twice more. The model tries to counter the counter, which is not an allowed move, so the brain drops the answer and falls back to its rules, which wait. The original bid stays up | [`87fENQNW…`](https://testnet.nearblocks.io/txns/87fENQNWfEPGdKCaBd746nPrVz2MA3uMidMS6jS9tqq1), [`HbwecafX…`](https://testnet.nearblocks.io/txns/HbwecafXdFmiNksv9pvuZAnstFb9giZYyuKJVqEimqNz) |
| 5 | A DOGE holder votes YES with tokens locked before the bid | [`F3KedJ9y…`](https://testnet.nearblocks.io/txns/F3KedJ9yak4CwajHr5YGjTMj5DM41ENDZXC8Hm9W6iPN) |
| 6 | After the 10-minute vote, `finalize`: DOGE's curve NEAR and treasury move into PEPE | [`7XGunS1G…`](https://testnet.nearblocks.io/txns/7XGunS1GSAHL7sbmmCayaK1kj3ojPRq39ajEGgRw1W3v) |
| 7 | The holder converts 28.73M DOGE into 22.28M PEPE at 0.775679 | [`8MVjG8eH…`](https://testnet.nearblocks.io/txns/8MVjG8eHMmHPtdZYaWXkq14cdkMdovxPyaZEfE1LWtLn) |

Step 4 is the design working as meant: a model answer that does not parse into an allowed move never reaches the contract. Those two decisions say `"mode":"rules"` and carry no signature.

**A contested vote, with a late buyer.** PEPE then went after a third coin, [`wojak.v3.scarpxvenom.testnet`](https://testnet.nearblocks.io/address/wojak.v3.scarpxvenom.testnet), with two holders on opposite sides:

| Step | What happened | Transaction |
|---|---|---|
| 1 | Two accounts buy WOJAK and lock it before any bid: `scarpxvenom.testnet` 55.96M, `tester.scarpxvenom.testnet` 17.22M | [`J1b6JJ6h…`](https://testnet.nearblocks.io/txns/J1b6JJ6h3DDVXMDrnPbB5AThMDWgjL24vuLErLixA1Mw), [`BGRbSW6i…`](https://testnet.nearblocks.io/txns/BGRbSW6i5N929ajtHMb52nnibZ9FkCzFg8To25wcfDRU) |
| 2 | PEPE's brain is woken 3 seconds before WOJAK's newborn protection ends. The model sees no biddable rival and waits | [`xJd2qdeY…`](https://testnet.nearblocks.io/txns/xJd2qdeYBMh6ZsfF9JMVDNoN2ZUMCLNrPeSmpJdwCDN) |
| 3 | Woken again after protection, the model bids for WOJAK at +8% (signed answer, decision #6) | [`9JjCh5Kr…`](https://testnet.nearblocks.io/txns/9JjCh5Kr3msqmLcs4a7gnJd88T1r758vXMSEjiLDs5oH) |
| 4 | `tester` buys 8.43M more WOJAK after the bid and locks it | [`CLHAsinb…`](https://testnet.nearblocks.io/txns/CLHAsinbgPbGixnwhghDCUnwMiSB5spgYkMeTox3xhta) |
| 5 | `tester` votes NO. Only the 17.22M locked before the bid count; the late 8.43M add nothing | [`ztrjdr8W…`](https://testnet.nearblocks.io/txns/ztrjdr8WnbtcgAMTcKJjgK5TqpJ5xUxmLvewvYMYHsE) |
| 6 | `scarpxvenom.testnet` votes YES with 55.96M: 76.5% yes, above the 67% needed | [`Fdykd8MN…`](https://testnet.nearblocks.io/txns/Fdykd8MN36frk3JsYtA3Qr4v5Jq1AsX6oUpiYVJrcW9t) |
| 7 | After the vote, `finalize`: WOJAK merges into PEPE at 0.855089 | [`5Zut42au…`](https://testnet.nearblocks.io/txns/5Zut42auiVspPou7DCWrr5Fc5HJxP63i6rj2rybd1kdX) |
| 8 | Both holders convert, the NO voter included: `tester` gets 21.93M PEPE for all 25.64M WOJAK | [`HWsjXYez…`](https://testnet.nearblocks.io/txns/HWsjXYezQmv35DFkHXCKrmTjbksGWKgRYTLkVjs78AmR), [`EPk3oSEc…`](https://testnet.nearblocks.io/txns/EPk3oSEcvSiaaW1VNR7DdnQuo1KCTdEXaED6shfU8U9i) |

Both accounts belong to the same person, so this proves the vote counting and the snapshot, not that strangers showed up. Check the results with `near view pepe.v3.scarpxvenom.testnet coin_info` (`absorbed` lists DOGE and WOJAK) and `near view doge.v3.scarpxvenom.testnet get_decision '{"id":0}'` (the signed counter).

The launchpad is locked: its only key was deleted ([`7BCPtpsh…`](https://testnet.nearblocks.io/txns/7BCPtpshg6RF8JfyTKb9qRhLpyCjc87eWsFu3GDmnxJR)), so it has 0 access keys and nobody can change it. Its coins have zero keys too. During the run above the NEAR AI key was readable only by brain runs that `scarpxvenom.testnet` woke; it has since been opened to any caller. A second account, `tester.scarpxvenom.testnet`, then woke PEPE's brain and got a signed model answer too ([`DjK4eg5m…`](https://testnet.nearblocks.io/txns/DjK4eg5mBGBuTQw2UmCqd3QuCXPCdxumw9JLJHontu7g), decision #4). Anyone can check that the launchpad's on-chain code hash equals `res/autocto_launchpad.wasm`, that `coin_code_hash` equals `res/autocto_coin.wasm`, and that `get_params` equals `params/testnet.json`.

## v2: rules-mode brain

[`v2.scarpxvenom.testnet`](https://testnet.nearblocks.io/address/v2.scarpxvenom.testnet) runs the same contracts with the rules-mode brain (sha256 `328d0eac…69c554`, commit `493e23f`) and is locked: its only key was deleted ([`8VUUph2F…`](https://testnet.nearblocks.io/txns/8VUUph2FjUxUTxDLiUgecJG4BnU2batkzfpUZM8Qtkno)), so it has 0 access keys. A whole takeover ran there too, with a counter that was accepted:

| Step | What happened | Transaction |
|---|---|---|
| 1 | PEPE's brain is woken. It bids for DOGE at +10% over the fair rate. OutLayer ran 1.38M instructions in 1.4 s and charged 0.0012 NEAR | [`GWJ6WxJ2…`](https://testnet.nearblocks.io/txns/GWJ6WxJ2mB5WgPVU6JpxYEgWnF5D9VUJBv7ZKQvggsGh) |
| 2 | DOGE's brain is woken. It counters at +20% | [`CGz2zkje…`](https://testnet.nearblocks.io/txns/CGz2zkjeYMBVzNEg78WzJh8N3X9RdTDB4x4WkxtSxEPu) |
| 3 | PEPE's brain is woken again and accepts the counter. A new voting round starts | PEPE's decision #1 |
| 4 | A DOGE holder votes YES with tokens locked before the bid | [`Cn9hBgkZ…`](https://testnet.nearblocks.io/txns/Cn9hBgkZfK1De4g29d97s7dzPTZ9EQuKdhsdpFfBEfQY) |
| 5 | After the 10-minute vote, `finalize`: DOGE's curve NEAR and treasury move into PEPE | [`B4EtwFnz…`](https://testnet.nearblocks.io/txns/B4EtwFnzxBqPFmBYNdMCAzeA8TKTzqqiHXXPJjybmbaV) |
| 6 | The holder converts 37.98M DOGE into PEPE at 0.983199 | [`XNByHRah…`](https://testnet.nearblocks.io/txns/XNByHRahR4hfg8jp2BB2bDcjon9BHaDvaS4Eh6qGkVN) |

**A tender for a meme.cooking token (on `v2`).** A PEPE holder nominated [`cook-112.factory.v10.meme-cooking.testnet`](https://testnet.nearblocks.io/address/cook-112.factory.v10.meme-cooking.testnet), a token launched on [meme.cooking](https://meme.cooking)'s testnet factory ([`HYf5HTHG…`](https://testnet.nearblocks.io/txns/HYf5HTHGdR1P8Zn5vYbSb85iPDEKpCGLQvjUUkar4Es3)). PEPE's brain checked that the token's contract has no access keys and opened an all-or-nothing tender at 0.0416 PEPE per token ([`9m74ssUn…`](https://testnet.nearblocks.io/txns/9m74ssUnUe2nTrkM4TUR22YuPbCPWwpR1Q8ycaruDg3V)). Nobody deposited and no PEPE holder backed it, so after the deadline `settle_tender` closed it as failed ([`CszRWyei…`](https://testnet.nearblocks.io/txns/CszRWyeiHtVaex1gEabX4R3nqQmayxS8ebvtfq6AbaAo)). It shows the rug check, the opening and the all-or-nothing close, not a completed swap.

## autocto: the first launchpad

An earlier launchpad, [`autocto.scarpxvenom.testnet`](https://testnet.nearblocks.io/address/autocto.scarpxvenom.testnet), was deployed and locked at commit `1290ae4`, before tender offers were added (0 access keys, tx `Cp16UaQE…`). Its one coin, `pepe.autocto.scarpxvenom.testnet`, made the first brain run through `outlayer.testnet` (request 16511).
