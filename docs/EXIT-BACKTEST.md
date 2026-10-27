# Exit backtest: how to size the dev buy and when to sell

`npm run simulate` replays recorded pump.fun launches with our dev position in place of the recorded dev's, under
each of about 1,300 selling plans, and asks which plan would have made the most. A plan is always chosen on one set
of launches and scored on launches it was not chosen on. This page explains the method, then records what it found.

## Method

**Replay.** Each launch's curve trades are replayed through pump.fun's constant-product curve
(`src/chain/curve.ts`): 30 virtual SOL against 1.073B virtual tokens at launch, with 0.95% protocol and 0.30% creator
fees on top of a buy and out of a sell. Checked against 48,146 recorded trades, the formula reproduces token amounts
to within 1e-8 and prices to within 1e-10.

**Rebuilding the trade order.** The feed sometimes delivers a slot's trades out of order and occasionally misses one.
Every recorded trade carries the price after it, so the state before it is known; trades are chained in the order
that reproduces every recorded state, and a missed trade is filled in with an inferred one covering the jump
(`src/sim/flow.ts`). About 8% of launches needed one.

**Our position in place of the dev's.** The recorded dev's trades are taken out. We buy in the create transaction
(the same SOL the dev bought, so the buyers saw the same dev buy) and sell under the plan. Everyone else trades as
recorded: buyers spend the same SOL, sellers sell the same share of what they hold, so our sells move the price they
trade at. Sells triggered by a trade land a set number of slots later (2 by default, 0.8 s). Each launch costs
0.02 SOL in rent and fees (measured on recorded create transactions: 0.010 and 0.025 SOL) and each sell 0.002 SOL.
Creator fees on every trade count as ours. Tokens still held at the end are valued at what selling them into the
curve would return.

**Replay check.** Replaying the recorded devs' own trades must reproduce their recorded results: it does to within
0.01 SOL on 96% of launches; the rest are feed gaps and devs whose tokens moved to other wallets.

**Population.** Normal (non-Mayhem) launches on the standard curve whose dev bought in the create transaction, by
single-wallet clean devs (one wallet as creator and signer, no wallets moving with it, no tokens passed to it):
the way this project launches. Launches whose replay would run into a stretch with no recorded trades are left out.

**Plans.** Three families: hold for a set time then sell everything; sell everything once outside net inflow
reaches a level (with a time limit and an exit when buying stops); and a four-step ladder of sells at rising inflow
levels, with an optional moonbag kept once the dev buy is recovered.

**Choosing without fooling ourselves** (the Eris rules from the roadmap's engineering standard):

- A plan is scored by its mean together with its one-step neighbours' (its plateau), so a lucky spike does not win.
- Among plans within 0.005 SOL of the best plateau, the simplest family wins.
- `--folds N` splits the launches into N blocks in time order and holds out each in turn; the pooled held-out results
  are the honest estimate of choosing plans this way.
- Differences come with a paired 90% bootstrap interval: a plan beats a benchmark only when the whole interval is
  above zero.
- Benchmarks: the recorded devs as they traded, and the simplest exit (sell everything at the first outside buy).

## A dev who buys first can lose at most the fees

On a normal curve the dev buys in the create transaction, at the lowest price there will ever be. No one can sell
back more tokens than they bought after that, so the curve's price never falls below the dev's entry, and the creator
fee on the dev's own trades comes back to the dev. A dev who sells the whole bag therefore loses at most the protocol
fee both ways: 1.9% of the dev buy, plus rent and network fees (`maxDevBuyLoss` in `src/chain/curve.ts`, checked by a
randomized test). Across 3,534 replays (1,178 normal launches, three hold times) the worst 1% lost 1.88% before costs; the five exceptions were inferred trades
and router accounts, not real losses. A front-runner cannot break this either, since it too can only sell what it
bought. Mayhem mode does break it: pump.fun's agent sells newly minted supply, which is how losing Mayhem devs ended
up selling at 9% of the launch price.

## Findings, 2026-10-27

### This morning's dev screen, checked on later hours

The findings in [DEV-SCREENING.md](DEV-SCREENING.md) were made on 04:22–05:25 UTC. Checked on 05:25–07:45 UTC (1,849
launches it was not built from; `npm run devs -- --since 2026-10-27T05:25Z --until 2026-10-27T07:45Z --clean`):

| Finding | 04:22–05:25 | 05:25–07:45 | Held? |
| --- | --- | --- | --- |
| Normal launches with activity: dev profitable, median | 94%, +1.47 SOL | 97%, +1.22 SOL | yes |
| Mayhem launches with activity: dev profitable, median | 38%, −0.06 SOL | 35%, −0.06 SOL | yes |
| Net inflow before the first dev sell 2–5 SOL: dev profitable | 100% | 99% | yes |
| Net inflow 0.5–2 SOL: dev profitable | 92% | 77% | weaker |
| Tranches vs one dump: dev profitable | 94% vs 71% | 89% vs 65% | yes |
| Creator fees as a share of dev profit on busy coins | 36% | 36% | yes |
| Sells match buys by 30 s (cumulative sell/buy SOL, 0–30 s) | 0.66 | 0.62 | yes |
| Later buyers profitable | 30% | 30% | yes |
| Buying held up after the dev's first sell | 77% | 73% | yes |
| Single-wallet clean devs on busy coins: profitable, median | 60%, +0.08 SOL | 53%, +0.04 SOL | weaker |
| Launches with activity | 16% | 29% | varies by hour |

Fit-period numbers differ slightly from DEV-SCREENING.md because its coins have traded for longer since. The
conservation check is now negative in both periods (−185 and −422 SOL), as it must be.

The check also exposed a gap in the clean definition: six of the biggest "clean" winners sold 5 to 26 times as many
tokens as they bought, so other wallets had bought and passed tokens to them. Devs that sell tokens they did not buy
are now excluded from the clean cohort.

### Exits: hold about 20 seconds, then sell everything

`npm run simulate -- --folds 3` on 716 clean launches from 04:22 to 07:27 UTC (150 busy). Each block's plan was
chosen on the other two:

| Held-out block | Launches | Plan chosen on the other blocks | Chosen | Recorded devs | Simple dump |
| --- | --- | --- | --- | --- | --- |
| 04:22–05:17 | 239 | hold 20 s then sell | +0.286 | +0.207 | +0.155 |
| 05:17–06:17 | 239 | hold 20 s then sell | +0.307 | +0.277 | +0.203 |
| 06:18–07:27 | 238 | hold 20 s then sell, moonbag 10% | +0.294 | +0.279 | +0.153 |

SOL per launch. Pooled over all held-out blocks the chosen plans made +0.295 SOL per launch, against +0.254 for the
recorded devs (+0.041, 90% interval +0.002 to +0.081) and +0.171 for selling at the first outside buy (+0.125,
interval +0.078 to +0.174). The median launch lost 0.022 SOL (the launch costs); 32% of launches were profitable;
the mean busy launch made +1.38 SOL and the mean dead one +0.008. Without the two best launches the total falls from
212 to 187 SOL, so the result does not hang on a few coins.

The hold time has a broad peak, not a spike (all 716 launches, SOL per launch):

| Hold | 3 s | 5 s | 10 s | 15 s | 20 s | 25 s | 30 s | 60 s | 120 s | 300 s |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Mean | 0.180 | 0.211 | 0.267 | 0.284 | 0.302 | 0.276 | 0.249 | 0.221 | 0.196 | 0.237 |

A timed exit does not depend on reacting fast: the result is the same whether the sell lands 0.4 s or 10 s after
the decision.

**The newest data disagrees in part.** On 105 launches from 11:35 to 12:00 UTC (5-minute replays), the morning's
plan made +0.221 SOL per launch: again far better than selling at the first buyer (+0.045; +0.176, interval +0.019 to
+0.371), but worse than the recorded devs (+0.327; −0.105, interval −0.191 to −0.028). The best plan in hindsight
sold in steps as inflow reached 8/16/32/64 SOL and held up to two minutes. The best hold may change with the time of
day; it needs several days of data.

### Dev buy: about 3 SOL draws the sniper bots

Clean launches, hold 20 s then sell, by the recorded dev buy (fees included):

| Dev buy | Launches | Devs | Median outside buy in first 3 s | Busy | Mean | Median | Profitable |
| --- | --- | --- | --- | --- | --- | --- | --- |
| under 1 SOL | 426 | 296 | 0.00 SOL | 7% | +0.016 | −0.022 | 11% |
| 1–2.95 SOL | 180 | 112 | 0.60 SOL | 37% | +0.175 | +0.019 | 56% |
| 2.95–4.5 SOL | 63 | 24 | 7.10 SOL | 56% | +1.396 | +0.774 | 84% |
| 4.5–6 SOL | 28 | 9 | 2.09 SOL | 43% | +1.722 | +0.085 | 54% |
| 6 SOL and more | 19 | 11 | 0.90 SOL | 47% | +1.936 | +0.570 | 79% |

The step is sharp at 3 SOL: clean launches buying 2.5–2.95 SOL drew at least 1 SOL of outside buying in the first
three seconds 25% of the time (8 launches); those buying 2.95–3.05 SOL, 66% (32 launches; 84% of 127 across all
normal launches). A 3 SOL buy takes about 9.8% of the supply and 4.5 SOL about 14%; among clean launches, early buying
falls off again above about 15% (5 SOL). Sniper bots appear to be set to buy when the dev holds roughly 10–14%. Among
dev buys of 1 SOL or more, the most common were exactly 3, 1 and 5 SOL plus fees.

It is not one dev's skill: the 63 launches in the 2.95–4.5 SOL band came from 24 devs, 20 of whom made money on
average; without the three busiest devs the band still made +1.19 SOL per launch (median +0.38, 78% profitable).
The buyers reacted to the dev buy, so a replay that swaps in a different dev buy cannot say what that buy alone
would draw; this table is the evidence.

## Caveats

- **Buyers react as recorded.** The replay cannot know whether buyers would treat our coin the way they treated the
  real one. Plans that sell before the recorded dev did look better than they would be (buyers then saw a dev still
  holding); plans that hold longer than the recorded dev did are, if anything, understated.
- **Our hit rate is unknown.** These are other devs' launches with their names and timing. The result rests on how
  often our launches draw buyers; dead launches cost little, so the busy share is the number to watch.
- **One morning of data.** 3.5 hours of 04:22–07:58 UTC and 25 minutes after 11:34 UTC; the observer recorded nothing
  from 07:58 to 11:34 UTC while the Mac slept.
- **Sniper settings can change any day.** The 3 SOL step is other bots' configuration and needs a daily check.
- **Dev profit comes out of other traders.** In the held-out hours, wallets buying after the launch window lost
  1,252 SOL on busy coins, while devs made 641 SOL on the same coins, creator fees included.
- **Assumed costs.** 0.002 SOL per sell for priority fees; Jito tips at busy times can cost more.

## What this means for the bot

A first playbook, to be re-fitted every day:

1. Launch in normal mode only, never Mayhem.
2. Buy about 3 SOL in the create transaction from the one public launch wallet.
3. Hold about 20 seconds, then sell the whole bag in one transaction, pre-signed on a timer with a tight slippage
   limit. Selling at the first buyers costs about 0.1–0.2 SOL per launch on average.
4. Most a launch can lose: about 0.06 SOL of fees on a 3 SOL buy, plus about 0.03 SOL of rent and fees.
5. Re-run `npm run simulate -- --folds 3` daily; change the plan only when a new one beats it on the pooled
   held-out blocks beyond the noise interval. The ladder that held up to two minutes is the first candidate.

## Commands

```bash
npm run simulate                       # split two thirds / one third, full report
npm run simulate -- --folds 3          # each time block held out in turn
npm run simulate -- --fit 2026-10-27T04:22Z..2026-10-27T07:50Z --test 2026-10-27T11:35Z..2026-10-27T12:00Z --horizon 5
npm run simulate -- --cohort normal    # all normal launches, bundled devs included
npm run simulate -- --json
```
