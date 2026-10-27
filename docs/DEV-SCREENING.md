# Dev screening: how pump.fun devs make (and lose) money

`npm run devs` screens every launch the observer recorded: what the dev spent, took out and earned in creator
fees, when and into what they sold, who else traded, and how the rest of the market treated the coin. This page
explains the method, then records what the screen found.

## Method

**Who the dev is.** pump.fun records a `creator` (who receives creator fees) and the wallet that signed the launch.
On about a fifth of launches they differ: the signer makes the dev buy while a fresh creator address collects fees.
The dev is both wallets. Coins launched before 2026-10-27 04:22 UTC lack the signer, so `--clean` limits the screen
to coins where the observer recorded it live.

**The dev's result** = SOL taken out by sells − SOL spent on buys + what unsold tokens would return if sold into the
curve now + creator fees. Unsold tokens are valued with the curve's constant-product formula and the 1.25% fee, not
at the last price, because selling a big bag moves the price. Bags on graduated coins are shown but left out, since
PumpSwap pool depth is not stored. Creator fees are measured from each trade event since 04:13 UTC that day and
estimated at 0.3% of volume before then. Network fees, priority fees and tips are not visible in the event logs.

**Coins with activity** had at least 10 buyers after the 3-second launch window, buying at least 1 SOL in total.

**First sell context.** At the dev's first sell the screen records the coin's age, how many other wallets had
bought, the SOL they put in and took out, the market cap against launch and against the eventual peak, the SOL
bought in the previous 10 seconds and the time since the last outside buy.

**Sell style.** `single_dump` (90%+ in one sell), `tranches` (several sells), `partial` (kept 10%+), `holding` (never
sold), `no_buy` (the dev never bought).

**Wallets moving with the dev.** Other wallets that bought in the launch slot, and launch-window buyers whose first
sell landed within 3 slots (about a second) of a dev sell. Two or more makes the coin bundle-like. The dev plus those
wallets is the "cluster" result.

**Single-wallet clean devs** are the cohort that launches the way this project will: one wallet as creator and
signer, no bundle-like wallets, and no tokens sold that the dev did not buy (other wallets buying and passing tokens
to the dev is a bundle the slot tests miss; added after the findings below were recorded). Their patterns are the
ones we can copy.

**pump.fun's Mayhem agent.** Coins launched in Mayhem mode are traded for 24 hours by pump.fun's own agent
(program `MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e`, trading as account `BwWK17…de6s`), fee-free and with extra
minted supply. The agent is reported apart and never counted as an organic buyer.

**Routers.** Most curve trades go through another program (trading terminals, Jupiter, GMGN, DFlow and others).
Most of them still name the trader in the event; a few pooled ones name one shared account for many traders, so
some wallets appear to sell tokens they never bought. Stored trades record the routing program (`trades.via_id`)
from 2026-10-27 04:39 UTC.

**Invariant.** On a bonding curve, all participants together, the Mayhem agent included, cannot come out ahead:
fees leave the system and SOL stays in the curve. The report prints this total; a positive number means missing
trades or overvalued holdings. It caught two bugs while the screen was built: bags valued at the last price, and
graduations missed during feed gaps.

**Sniper bots are not the dev's wallets.** A wallet that bought in the launch window of 3+ different devs' coins, or
bought 10+ coins in the window, is a sniper bot and is not counted as moving with the dev. Without this test about
three quarters of busy normal coins looked bundled; with it, about half do, and a stricter test (wallets that only
ever appeared with one dev and bought at most 3 coins) puts likely bundles at about a quarter.

## Findings, 2026-10-27

These were checked the same day on the following hours, which they were not built from; most held, and the
comparison is in [EXIT-BACKTEST.md](EXIT-BACKTEST.md).

Run: `npm run devs -- --hours 2 --min-age 15 --clean` at 05:40 UTC. 1,009 SOL-quoted launches from 04:22 to 05:25
UTC (launch buyouts excluded), each with its signer and creator fees recorded live; 160 had trading activity. One
hour of one morning: treat these as strong leads, not settled facts. The invariant check came out at +10.6 SOL on
about 13,000 SOL of volume, so a little routed volume is still double-counted.

### The market

- **60% of launches used Mayhem mode.** Normal launches drew the activity: of coins with activity, 115 were
  normal and 45 Mayhem.
- **84% of launches drew no real trading** (fewer than 10 buyers after the launch window). Their devs broke even
  at the median.
- **The money arrives in the first ten seconds.** In coins with activity, other wallets bought 1,236 SOL in the
  first 3 seconds and sold 438; by 30 seconds sells matched buys, and after a minute selling slightly exceeded
  buying.
- **Who wins among buyers:** launch-window buyers (sniper bots, median hold 6 seconds) were 42% profitable and
  +112 SOL in total. Later buyers were 31% profitable and −430 SOL. Wallets we label smart money were 53%
  profitable. Ordinary unlabelled wallets lost most.
- **Organic buy size per wallet:** median 0.23 SOL, 90th percentile 1.6 SOL.
- **A dev sell does not end a coin with real demand.** After the dev's first sell, buying in the next minute held at
  half or more of the previous minute on 77% of coins, and 56% peaked after the dev's first sell.

### How devs did

| Coins with activity | Dev profitable | Median result | Notes |
| --- | --- | --- | --- |
| Normal launches (115) | 95% | +1.37 SOL | Median dev buy 3 SOL, first sell after 4 s, 93% have an X link |
| Mayhem launches (45) | 40% | −0.06 SOL | Median dev buy 0.18 SOL, first sell after 44 s |
| Single-wallet clean devs (86) | 64% | +0.09 SOL | Median dev buy 1 SOL; 42% of their total came from creator fees |
| Everyone else (74) | 97% | +2.04 SOL | Took 83% of all dev profit on busy coins |

- **Creator fees were 35% of all dev profit on busy coins** (88 of 250 SOL). The best clean coin, ELUN, made its
  dev +7.58 SOL, of which 6.72 SOL was creator fees from 527 organic buyers.
- **Net inflow before the dev sells decides the result.** For all devs on busy coins: under 0.5 SOL of net outside
  inflow, 39% profitable and −0.30 SOL per SOL of dev buy; 0.5–2 SOL, 91% and +0.11; 2–5 SOL, 100% and +0.32;
  5–15 SOL, 100% and +0.69.
- **Selling in tranches beat dumping.** Tranches: 94% profitable, median +2.34 SOL, 42 organic buyers. Single
  dump: 75%, +0.17 SOL. For clean devs on normal coins, tranches were 10 of 10 profitable at a median +2.19 SOL.
- **Fast first sells did best, and the coin usually kept running.** First sell within 10 seconds: 96% profitable,
  median +1.73 SOL, and 75% of those coins peaked later. First sell at 1–3 minutes: 44%, −0.12 SOL.
- **Losing devs sold late into a dying curve.** Their median first sell came at 59 s, when the price was 9% of the
  launch price and 7% of the peak. A curve price can only fall below launch on Mayhem coins, where the agent sells
  minted supply, and 82% of the losing coins were Mayhem.

### What the profitable devs do

1. **Launch on a live narrative within seconds, with real links.** Top coins rode names that several devs were
   launching at the same time (OPTIMUS, CapyHub, GTA, OSSO, ELON), with an X link and website. Several devs used the same 5.06 SOL dev buy, which
   looks like a launch tool's preset.
2. **Buy 3–6 SOL at launch and sell in 3–8 tranches starting within seconds,** into the rush of buyers in the first
   10–30 seconds.
3. **Launch again every few minutes.** The top 12 devs ran 1–9 launches each, 1–19 minutes apart.
4. **Many add wallets around the launch** (likely bundles on roughly a quarter to half of busy normal coins), or sign
   with one wallet while a fresh creator address collects fees (25% of busy normal coins), which keeps their history
   off GMGN and Axiom's dev checks. We do neither.

### Edges that did not last

- A dev launched over 100 "Cornell" coins in Mayhem mode in the early morning, bought 6–15 SOL at launch and sold
  into pump.fun's agent, which spent 253 SOL more than it took out on those coins: +65 SOL for the dev by 04:00
  UTC. In the next hour the same dev lost 5 SOL on 25 launches. Another dev made 69 launches with none drawing
  buyers. Patterns that depend on one counterparty or on spam stop working within hours.

### What this means for our bot

- Copyable and honest: launch fast on a live narrative with real links, size the dev buy to the inflow we expect,
  sell in tranches into the first 10–30 seconds of real buying, keep a moonbag because most busy coins keep running
  after the dev's first sell, and treat creator fees as a main revenue line.
- The single-wallet clean devs who did this on normal coins made money (20 of 21 single dumps, 10 of 10 tranche
  sellers), but in amounts of tenths of a SOL to a few SOL per coin. The large per-coin wins mostly went to devs using
  extra wallets.
- Not copyable: bundles, rotating creator addresses, and farming the Mayhem agent.
