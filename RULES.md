# AutoCTO rules

The rules below are set when a launchpad is created and are the same for every coin it launches. There is no owner and no setter: nobody can change them afterwards, including whoever launched the launchpad or the coin. The coin contract enforces all of them; a coin's AI brain can only propose.

| Rule | Demo | Recommended (`params/recommended.json`) |
|---|---|---|
| Vote period | 60 s | 2 days |
| Quorum (turnout, share of the target's circulating supply) | 10% | 10% |
| Approval (YES share of votes) | 67% | 67% |
| Buyer veto (share of the buyer's circulating supply) | 10% | 10% |
| Premium cap / discount floor vs fair rate | +30% / −30% | +30% / −30% |
| Dilution cap (new buyer tokens vs buyer supply) | 100% | 100% |
| Newborn protection | 30 s | 3 days |
| Re-bid cooldown after a failed bid | 120 s | 5 days |
| Bids per coin per day | 3 | 3 |
| Brain fee / daily treasury cap | 0.05 Ⓝ / 1 Ⓝ | 0.05 Ⓝ / 1 Ⓝ |
| Private voting: reveal window after the vote (0 = open votes) | off | 1 day |
| Tender period | 60 s | 3 days |
| Tender threshold (share of the outside token's supply) | 40% | 40% |
| Tender dilution cap (new tokens per tender vs supply) | 20% | 20% |

## How a bid is decided

1. A coin can bid for another coin of the same launchpad, at a rate within the premium cap and discount floor of the fair rate. The fair rate is the ratio of the two curves' spot prices at bid time.
2. Only tokens locked before the bid was announced can vote on it or veto it.
3. The bid passes if turnout among the target's holders reaches the quorum and the YES share reaches the approval threshold, unless the bidder's own holders reach the veto threshold.
4. If it passes, the target's curve NEAR and treasury move to the bidder, and the target's holders convert at the agreed rate. The new bidder tokens are bounded by the dilution cap.
5. If it fails, the same bidder waits out the re-bid cooldown before bidding for that coin again.

## What the brain may do

Propose one of: a bid, a counter-offer, accepting a counter-offer, advice to its holders, a tender for a nominated outside token, or nothing. Every number it proposes goes through the same checks as a holder's proposal. It holds no key and moves no funds.

Values on a live launchpad: `near view <launchpad> get_params`. Source of the numbers: [`params/`](params/) and the simulation in [`sim/`](sim/).
