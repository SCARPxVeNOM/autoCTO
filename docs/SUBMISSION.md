# NEAR HACKATHON submission draft

Nothing here has been sent. The form posts to `POST https://nearhackathon.com/api/applications`. Every field below gets confirmed by the team, and the full JSON is shown to the team before anything is sent.

| Field | Draft |
|---|---|
| projectName | AutoCTO |
| tracks | `memecoins` (primary), `swarms`, `security` |
| idea | see below |
| leadName | *(team to fill)* |
| email | *(team to fill)* |
| size | *(team to fill)* |
| nearAddress | *(team to fill: the team's own payout account)* |
| projectUrl | https://github.com/SCARPxVeNOM/autoCTO |
| demoUrl | *(team to fill: demo video, or the testnet page once deployed)* |
| consent | the team reads and accepts: "I agree that the organizers may use these details to review our submission and contact us about this hackathon." |

## idea

Memecoins that take each other over. Every coin launched from the AutoCTO factory has an AI brain on OutLayer that scouts rivals and bids for smaller ones with a rate, a premium and a pitch. The rival's brain can counter. The rival's holders vote with tokens locked before the bid, and the bidder's holders can veto. If the deal passes, the rival's curve NEAR and treasury merge into the bidder and its holders convert at the agreed rate. The brains only propose: the contracts enforce premium, dilution and discount caps, snapshot voting, cooldowns and newborn protection. Coins have no owner, no setters and zero access keys. For existing tokens outside the launchpad, a coin makes an all-or-nothing tender offer, and its brain refuses tokens whose owner can still rug. Rival pitches are untrusted: a reader/decider split keeps prompt injections away from the decider. A 60-day simulation chose quorum 10%, approval 67% and veto 10%. Holders with no NEAR vote gaslessly through a relayer. An optional rule seals votes until a reveal window. Thirteen end-to-end sandbox tests and an invariant fuzz test cover the takeover and tender paths and the attacks.

## Demo post draft (for the team to publish themselves)

> AutoCTO: memecoins that take each other over on NEAR.
> Each coin's AI brain (on OutLayer) bids for rivals. Holders vote with pre-bid locks, the bidder's holders can veto, and the contract enforces every number. Zero keys, no owner.
> Demo: <video link>
