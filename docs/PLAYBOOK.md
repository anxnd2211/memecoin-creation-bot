# Playbook

How the bot launches and sells, versioned in `src/playbook.ts`. A new version replaces the current one only when it
beats it on launches held out from its choice by more than the noise, and the owner approves. Every launch will
record the version it used. The evidence comes from other devs' recorded launches; the bot's own launches are the
next test.

## Version 1 (2026-10-27)

1. **Normal mode only, never Mayhem.** In Mayhem mode pump.fun's agent sells newly minted supply, so the price can
   fall below the dev's entry.
2. **One public wallet** as creator and signer, on every launch.
3. **Dev buy: 3 SOL** in the create transaction (3.04 SOL with fees, about 9.8% of supply).
4. **Links:** the X link points to the specific post the narrative came from (not a profile), and the website field
   is the narrative's original source: the article, video or official site.
5. **Exit:** hold at least 10 seconds, then sell the whole bag once other wallets' net buying over the last 10
   seconds is 0.5 SOL or less, and at two minutes at the latest. While the trade feed runs more than 2 seconds
   behind the chain, or its lag is unknown, sell the whole bag at 20 seconds instead.
6. **One sell, no moonbag.** Other wallets dump the moment the dev sells, so a partial sell exposes the rest of the
   bag; a whole-bag sell keeps the dev's loss bounded by the fees.
7. **Pause after three dead launches in a row** for a review: a wallet whose launches keep dying stops drawing buyers.

The most a launch can lose is about 0.06 SOL of fees on the 3 SOL buy plus about 0.03 SOL of rent, network fees and
tips, provided the whole bag is sold (see the loss bound in [EXIT-BACKTEST.md](EXIT-BACKTEST.md)).

### Evidence

Single-wallet normal launches recorded on 2026-10-27, 04:22–19:54 UTC (`npm run traits`, `npm run simulate`). SOL
per launch under the v1 exit unless stated.

| Check | Result |
| --- | --- |
| Exit, launches with a 3 SOL+ dev buy, each of 3 time blocks held out (199 launches) | v1 exit +1.90; recorded devs +1.59 (+0.30, beyond noise); selling at the first buyer +0.89 |
| Exit, all launches, each of 4 time blocks held out (1,227 launches) | chosen plans +0.351; recorded devs +0.325 (within noise); selling at the first buyer +0.183 |
| Exit and feed lag, 3 SOL+ launches | flow exit +2.08 at 0.8 s lag, +2.04 at 2 s, +1.96 at 10 s; 20 s timer +2.04 at any lag |
| Dev buy 2.95–4.5 SOL vs 1–2.95 SOL (1,379 launches) | 53% vs 34% drew buyers; +1.76 vs +0.16; both halves of the day agree |
| Link to a post vs no X link | 38% vs 14% drew buyers; +0.99 vs +0.01 |
| Website vs none | 41% vs 20% drew buyers; +0.93 vs +0.15 |
| Launches meeting every v1 rule (70) | +2.35 mean, +1.68 median, 94% profitable, 66% drew buyers; halves +1.98 and +3.22 |
| Dev's earlier launches all dead vs one was busy | 7% vs 41% drew buyers |

The launch rules were picked on these same launches, so the 70-launch figure is in-sample even though each rule held
in both halves of the day. If all 18 launches in the 3 SOL band whose metadata could not be fetched had met the
rules, the figure would fall to about +2.06.

### What the evidence cannot say

- **Whether our coins draw the same buyers.** These are other devs' launches, with their narratives and timing. The
  share of our launches that draw buyers is the unknown that decides profit, and paper mode exists to measure it.
- **Whether it lasts.** The 3 SOL step and the dev-sell dumps are other traders' bot settings, and one day of data
  (with gaps while the Mac slept) is not a season.
- **Who pays.** Dev profit comes out of other traders: wallets buying after the launch window lost money on busy
  coins in both periods measured (631 and 1,252 SOL).

## Version history

| Version | Adopted | Change | Why |
| --- | --- | --- | --- |
| 0 | 2026-10-27 | Normal mode; 3 SOL dev buy; hold 20 s then sell everything | Round 1 of the exit backtest |
| 1 | 2026-10-27 | Flow exit with a 20 s timer when the feed is slow; require a post link and a source website; pause after 3 dead launches | Round 2: dev-sell reactions modelled; launch traits measured |

## Rules learned

Each rule is dated with its evidence, so a later version can check whether it still holds.

| Date | Rule | Evidence |
| --- | --- | --- |
| 2026-10-27 | Never launch in Mayhem mode | 35–38% of Mayhem devs on busy coins profited vs 94–97% of normal ones; 81–95% of losing devs were Mayhem |
| 2026-10-27 | Buy 3 SOL, not less | Outside buying in the first 3 s: a median 7 SOL at 3–4.5 SOL dev buys, under 1 SOL just below 3 SOL |
| 2026-10-27 | Never sell into the first buyers | Selling at the first outside buy made 0.1–1.0 SOL less per launch, beyond noise, in every held-out check |
| 2026-10-27 | Sell the whole bag in one transaction | Other wallets sold 15 times their usual rate in the dev's slot and 4 times in the next |
| 2026-10-27 | Hold while buying lasts, but only on a fast feed | The flow exit beat the recorded devs on 3 SOL launches; its edge is gone at 2 s of feed lag |
| 2026-10-27 | Link the post and the source | Coins without an X link drew buyers 14% of the time; post links 38%; profile links made +0.34 vs +0.99 |
| 2026-10-27 | Protect the wallet's record | Devs whose earlier launches all died drew buyers 7% of the time |
| 2026-10-27 | Do not trust a backtest that ignores reactions | Without modelling dev-sell dumps, plan rankings disagreed between time blocks and the recorded devs looked better |

## How the playbook improves

Every day, on the newest data:

```bash
npm run simulate -- --folds 4 --horizon 10 --min-dev-buy 2.95   # does the exit still win on held-out blocks?
npm run traits                                                  # do the launch rules still pick the winners?
npm run devs -- --hours 24 --clean                              # has dev behaviour or the 3 SOL step shifted?
```

A candidate becomes the next version only if, on held-out blocks, it beats the current one beyond the noise
interval, the owner approves it, and its change, reason and evidence are added above. Once the bot launches, each
batch of its own launches is scored the same way against these expectations, and every loss adds a dated rule.
