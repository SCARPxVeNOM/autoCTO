# AutoCTO simulation report

60 days per scenario, seeded (re-run with `node sim/simulate.mjs`).

## Scenarios with the chosen parameters (circulating supply in millions, day 0 → day 60)

### Friendly merger: bid +10%, counter +20%, accepted
- PEPE: 608.52 → 585.77
- DOGE: 237.68 → 0
- outcome: day 9: DOGE MERGED into PEPE at 0.3360

### Hostile lowballs: -20%, then -5% (cooldown), then +3%
- PEPE: 611.03 → 557.67
- DOGE: 248.54 → 253.65
- outcome: day 7: PEPE → DOGE failed: rejected by holders · day 14: PEPE → DOGE failed: rejected by holders · day 22: PEPE → DOGE failed: rejected by holders

### Insiders push an overpriced bid: snapshot drops the late whale, PEPE holders veto
- PEPE: 655.98 → 583.22
- DOGE: 568.49 → 566.41
- outcome: day 7: late whale's lock refused by the snapshot rule · day 8: PEPE → DOGE failed: vetoed by buyer holders

### Chain of three: WOJAK bids for an engaged DOGE (70% of holders lock), then PEPE bids for WOJAK
- PEPE: 713.97 → 794.29
- DOGE: 168.07 → 0
- WOJAK: 398.58 → 0
- outcome: day 10: DOGE MERGED into WOJAK at 0.6258 · day 32: WOJAK MERGED into PEPE at 0.3917

### Bidding war over a newborn: protection, then +12% vs +22%
- PEPE: 626.82 → 540.13
- WOJAK: 519.7 → 590.52
- BABY: 0 → 0
- outcome: day 15: BABY MERGED into WOJAK at 0.5136 · day 11: PEPE → BABY refused: newborn protection · day 15: PEPE → BABY failed: target already merged

## Parameter sweep (27 combinations × 400 random bids)

score = good-deal pass rate − 3 × bad-deal pass rate. Bad = a discount for the target, or >60% dilution at >20% premium for the buyer. 30% of bids face a whale who buys and locks after the bid.

| quorum | approval | veto | good deals pass | bad deals pass | score |
|---|---|---|---|---|---|
| 10% | 55% | 10% | 91.1% | 0.0% | 0.911 |
| 10% | 55% | 15% | 91.1% | 0.0% | 0.911 |
| 10% | 55% | 25% | 91.8% | 1.0% | 0.887 |
| 10% | 60% | 10% | 87.7% | 0.0% | 0.877 |
| 10% | 60% | 15% | 87.7% | 0.0% | 0.877 |
| 10% | 67% | 10% | 87.0% | 0.0% | 0.87 |
| 10% | 67% | 15% | 87.0% | 0.0% | 0.87 |
| 10% | 60% | 25% | 88.4% | 1.0% | 0.853 |
| 10% | 67% | 25% | 87.7% | 1.0% | 0.846 |
| 20% | 55% | 10% | 40.4% | 0.0% | 0.404 |

Chosen (most conservative within 0.05 of the best score): quorum 10%, approval 67%, veto 10%, score 0.87. Late whale locks never counted (snapshot rule); bad deals that passed with a whale present: 0 of 121 attacked bids.
