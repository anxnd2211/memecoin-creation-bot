# Playbook

How the bot launches and sells, versioned in `src/playbook.ts`. A new version replaces the current one only when it
beats it on launches held out from its choice by more than the noise, and the owner approves. Every launch will
record the version it used. The evidence comes from other devs' recorded launches; the bot's own launches are the
next test.

## Version 5 (2026-10-29): current

v4 with the pause back at 3 dead launches in a row. See the version history and the review's third session.

## Version 4 (2026-10-29): after the first live batch

v3's rules, with three changes from the review of the first live batch (3 follower launches at 2 SOL on 2026-10-28,
all dead, −0.11 SOL; the full review is [REVIEW-2026-10-29.md](REVIEW-2026-10-29.md)):

- **Pause after 6 dead launches in a row, not 3.** With fake demand left out (below), a first launch draws buyers
  about 1 time in 3, so 3 dead in a row happens by chance about 30% of the time. On a 2.43 SOL wallet at half the
  recorded hit rate, pausing at 3 gave +1.51 SOL a 10-launch session with a 22% chance of ending down; pausing at 6,
  +2.89 and 9% (`python3 ml/followgate.py`). Six in a row is a 9% event by chance, so it still flags a broken path.
- **The follower follows only launches that others are buying** (and, after the second live session, only watches in
  live mode: 0 of 4 live second launches drew a sniper buy): 1+ SOL from other wallets in the trigger's first 3 s,
  its create slot left out (a trigger's own bundle lands there). On recorded second launches with real demand,
  followed ones made +0.74 at a 2 SOL bag (70% profitable) against +0.45 (54%) for the rest, the same way in both
  halves of the record. Two of our three triggers were dead themselves.
- **Expectations and comparisons use real demand only.** Half of the recorded first launches (47–50%) were copy
  launches (one operator launching the same metadata from many fresh wallets) or bundled (create-slot buys by wallets
  that only ever buy that dev's coins). Selling into your own wallets is not profit. Without them, a first launch on
  a post under 2 min old made **+0.61 to +0.68 SOL at a 2 SOL bag** (not +1.32) and drew buyers **33–37%** of the
  time (not 50%). The export, the watchlist and the post-mortem now leave them out (`src/sim/demand.ts`).

### What the first live batch did and did not show

- **Not a cold wallet.** New devs (no launch in 12+ hours of recording) were sniped as often as devs with a history,
  and devs with no prior launch were sniped more at 2 SOL (65%) than devs with 10+ (39%) (`python3 ml/coldstart.py`).
- **Not a fingerprint.** 252 failed transactions on one of our coins were one trader's private program firing a guarded
  buy about 4 times a slot; its own check said no (error 0x6f) without ever calling pump.fun: a momentum bot waiting
  for buying that never came.
- **The posts were dead.** On the same posts in the same minutes, the launches we followed drew 0, ~1 and 3.6 SOL;
  ours drew 0.43, 0 and 0. Independent sniper bots (wallets buying create slots across 5+ devs) are real and buy
  pump.fun-site launches too, but they did not buy launches on posts whose first launch had failed.
- **Speed still decides first launches:** with real demand, posts ≤30 s old made +0.71, 30–120 s +0.26 to +0.29, in
  both halves.

## Version 3 (2026-10-28): superseded by v4 on 2026-10-29

Version 2, plus three launch rules and a sell limit:

1. **Website: the narrative's source**, where the story started: the post itself, Instagram, TikTok, YouTube or a
   news page. Never a promo, referral or trading-tool site (otcdesks.cash, axiom.trade and the like).
2. **Skip farmed accounts:** do not launch on a post by an X account that 3 or more launches linked in the hour
   before.
3. **At least 10 minutes between our launches.**
4. **Sell limit 10%:** the whole-bag sell fails rather than fill more than 10% under its quote. A failed sell is
   re-quoted and re-sent at once. Sells go through a protected route (a Jito bundle or Helius Sender).
5. **Slow feed:** the flow exit runs while the feed is at most 3 seconds behind the chain; beyond that, or with the
   lag unknown, the whole bag is sold at 15 seconds.

The dev buy stays at 5 SOL; the evidence against going lower is below. The exit is unchanged.

### Evidence

Research launches up to 22:31 UTC; `python3 ml/sentiment.py`, `ml/design.py`, `ml/rulecheck.py`; 334 feature tests,
each required to replicate in both halves of the hours:

| Check | Result |
| --- | --- |
| No website, launches with a 2.95+ SOL dev buy (replicated) | −1.3 and −1.0 SOL a launch in the two halves |
| Website by kind (2.95+ SOL) | Instagram +4.39, X +3.81, TikTok +3.64, other sites +3.29 (mostly otcdesks.cash), none +2.26 |
| Promo site against the other launches on the same post (replicated) | drew buyers 26% and 24% less often |
| Account linked by 3+ launches in the hour before (replicated) | drew buyers 12% less often in both halves |
| Same dev launching within 10 min of its previous launch (112 devs) | −0.57 SOL a launch, and snipers put in less |
| v3 rules against v2, 5 SOL launches | earlier half +5.69 vs +5.06; later half +5.63 vs +3.89 |
| v3 rules against v2, 3–5 SOL launches | earlier half +3.25 vs +2.94; later half +3.56 vs +3.17 |
| Bag-value move between the sell decision and landing | under 2.5% for 95% of sells, under 8.2% for 99%; a 10% limit fails 0.5% |
| Flow exit vs the 20 s timer by real delay, 713 launches at 5 SOL (slots are 0.213 s, not 0.4) | +0.22 at 0.4 s, +0.17 at 1–1.5 s, +0.12 at 2.5–3 s (all beyond noise), +0.05 at 5 s (noise) |
| 15 s timer vs 20 s timer, same launches | 3.60 vs 3.49 SOL a launch |
| Live shadow runs on the public feed (exit only, 3 SOL+ launches, no link rules) | 14 runs +3.45 (all profitable); 10 runs +2.55 |
| Live shadow session in our band, 2026-10-28 01:08–02:14 UTC (102 launches at 3–5.2 SOL, feed lag 1.41 s) | +2.09 a launch (median +1.25, 84% profitable) against +1.85 for the recorded devs. At 86 runs: +0.21 (90% −0.30 to +0.70), ours better on 66% of launches. 13 exits fell back to the 15 s timer when the lag passed 3 s. The recorded devs started selling at a median 4.5 s, 77% before 10 s |
| Fork batch, 30 latest recorded 5 SOL launches through the live launcher (`npm run live -- --mode fork --batch 30`) | +2.33 a launch against +2.49 in the backtest on the same coins. The gap is mostly creator fees, counted for 60 s after the sell here and for 10 minutes in the backtest |
| Live shadow session, 2026-10-28 00:38–01:08 UTC (88 launches, feed lag 1.25 s, all flow exits) | +4.80 a launch, 86% profitable. Ours beat the recorded dev on 56% of launches. Inside our band: 3 SOL +1.57 vs +1.12, 3.2–4.9 SOL +2.78 vs +1.96, 5 SOL +2.13 vs +2.22 (10 runs). Above 5.2 SOL the devs who held runners for minutes did better (+10.64 vs +8.11), the tail no exit predicted in time |

The sealed launches (22:35–23:09) had only 2 that met every v3 rule: not enough to confirm it yet.

### Why not a 2–3 SOL dev buy

- **Bigger buys did not scare traders off.** 5 SOL launches drew 62 buyers after the first 10 s per dev, against 34
  at 3 SOL. The same 18 devs at both sizes drew +5 buyers at 5 SOL (90% −15 to +23): no deterrent shows. And 5 SOL
  made +1.20 SOL a launch more (+0.15 to +2.37).
- **2–3 SOL pays less even per SOL put in.** On the first launch on a post under 2 minutes old: 2–2.95 SOL made
  +1.16 a launch (0.48 per SOL), 3 SOL +2.23 (0.75 per SOL), 5 SOL +4.46 (0.89 per SOL). Snipers start at about
  2.95 SOL into the curve.
- **Getting sniped is where the money comes from.** The most-sniped quarter of launches made +5.06 SOL each and were
  100% profitable; the least-sniped quarter made +1.55, 67% profitable. Snipers put in a median 5.3 SOL, start
  selling about 11 s in, and have taken out 74% of it by 30 s, which is why the exit holds about 10 s and then
  watches for buying to stall. No one can buy before our dev buy: it is in the create transaction.
- **A dumping record did not cost devs their snipers.** Devs who sold 80%+ of their earlier launches within 60 s
  were sniped as often on their next launch as other devs with a busy launch behind them. What predicts snipers is
  a busy launch in the dev's history (+11–17% drew buyers, replicated), not whether the dev held.

### A smaller wallet: an exact 2 SOL dev buy

Sniper bots also answer exactly 2.000 SOL into the curve (2.025 with fees): sniped 74–79% of the time across 73–86
devs, against 12–49% for 1.95–1.97 SOL and 43–57% for 2.1–2.4 SOL. Strong-post launches at 2 SOL made +1.24 SOL each
(162 launches, 82 devs), against +2.22 at 3 SOL and +4.36 at 5 SOL; the same 19 devs made about the same at 2–2.95 SOL
as at 3 SOL (+0.02, 90% −0.42 to +0.49). A wallet too small for 5 SOL launches with `--dev-buy 2` or `auto`
(2 SOL until it can afford 5); never an amount between the tiers. Evidence: `python3 ml/smallwallet.py`.

### Launching second: the launch-follower

Without an X key no one is watching X, so `--follow` turns the first launch on a post into the trigger for ours: the
feed sees it within a second, its metadata names the post, and ours becomes the second launch on the post. Recorded
second launches arriving within 60 s of the first on a post under 3 minutes old: +1.14 SOL a launch at a 2 SOL bag
(576 launches, 65% profitable, about 16 chances an hour); first launches +1.34. Whether the first launch was sniped
makes little difference (+1.17 vs +1.05). The first-on-post gate then allows exactly one prior launch.

### Next candidate: a 7 SOL dev buy

On all data to 2026-10-28 02:30 UTC, each size's expected result weighs how often snipers come by what our bag
makes when they do and when they don't:

| Dev buy | Snipers came | Expected SOL a launch |
| --- | --- | --- |
| 5 SOL | 80% (94 devs) | +2.84 |
| 7 SOL | 84% (14 devs) | +3.65 |
| 8 SOL | 88% (12 devs) | not modelled |
| 10 SOL | 21% (58 devs) | +1.77 |

Snipers fall away sharply above about 8 SOL. 7 SOL may beat 5, but its sniper odds rest on 14 devs, and it would
need about 9.5 SOL of funding. Test it after the first 5 SOL batch, with `python3 ml/devbuy.py` re-run first. Never
buy above 8 SOL.

## Version 2 (2026-10-28)

1. **Normal mode only, never Mayhem.** In Mayhem mode pump.fun's agent sells newly minted supply, so the price can
   fall below the dev's entry.
2. **One public wallet** as creator and signer, on every launch.
3. **Dev buy: exactly 5 SOL into the curve** (5.0625 SOL with fees, about 15% of supply), in the create transaction.
   Sniper bots buy as readily at 5 SOL as at 3, and the bigger bag takes a bigger share of what they put in.
4. **Speed and order:** launch only while the linked post is at most 2 minutes old, aiming for under 30 seconds, and
   only if no other launch has linked that post yet.
5. **Links:** the X link points to the post the narrative came from. Add the original source as the website when
   there is one; it is no longer required, because once post age and order are in, it added nothing on fresh hours.
6. **Metadata on pump.fun's own IPFS** (an ipfs.io URI), like coins made on the site. Sniper bots skip some launch
   tools' launches: the spam tool's 5 SOL launches were sniped 45% of the time, ipfs.io's 93%.
7. **Exit:** hold at least 10 seconds, then sell the whole bag once other wallets' net buying over the last 5 seconds
   is 0.5 SOL or less, and at two minutes at the latest. While the trade feed runs more than 2 seconds behind the
   chain, or its lag is unknown, sell the whole bag at 20 seconds instead.
8. **One sell, no moonbag.** Most profitable devs split their sell into about four pieces within 30 seconds; on the
   same coins that made 0.65 SOL a launch less than this exit. Keeping a moonbag did no better either.
9. **Pause after three dead launches in a row** for a review.

The most a launch can lose is about 0.10 SOL of fees on the 5 SOL buy plus about 0.02 SOL of rent and network fees
(0.117 SOL for the worst replayed launch), provided the whole bag is sold.

### Evidence

Normal launches recorded on 2026-10-27, 04:22–22:08 UTC (with the gaps while the Mac slept left out); "fresh hours"
are 19:54–22:08, after v1 was chosen. Results are SOL per launch under the v2 exit unless stated. Reports:
`npm run export-launches`, then `python3 ml/devbuy.py`, `ml/sells.py`, `ml/launchers.py`, `ml/model.py`
([MODELS.md](MODELS.md)), and `npm run simulate -- --folds 4 --horizon 10 --min-dev-buy 2.95 --cohort normal`.

| Check | Result |
| --- | --- |
| Same dev at 5 SOL vs 3 SOL (17 devs who launched both) | +1.26 a launch (90% +0.18 to +2.58); sniped 88% vs 89% |
| Dev buy bands, each dev counted once (spam tool left out) | 3 SOL +1.50 (116 devs); 4 SOL +2.24 (44); 5 SOL +3.70 (71), and +3.73 on the fresh hours |
| Same outside flow, bigger bag (3 SOL launches replayed) | with 5 SOL +2.57 instead of +1.79; worst launch −0.117 instead of −0.079 |
| Where the sniper bots start | 2.917 SOL into the curve: sniped 25% of the time; 2.954–2.963: 75–87%; 3.000: 90% |
| Age of the linked post at launch (3 SOL+ launches) | under 30 s +3.49 (398 launches); 1–2 min +2.61; 2–5 min +1.86; over 6 h +0.57 |
| First launch on a post vs later ones on the same post (265 posts) | +3.11 vs +1.57; the second launch came a median 24 s after the first |
| Exit, 4 time blocks each held out (1,059 normal 3 SOL+ launches) | chosen +2.65 vs recorded devs +2.00 (+0.65, 90% 0.53–0.78); every block chose a 3–5 s window |
| 5 s window vs v1's 10 s (1,072 launches) | +0.09 (90% 0.02–0.15) |
| Best split and best moonbag plan vs this exit | split −0.13 (−0.22 to −0.04); moonbag +0.02 (−0.03 to +0.08) at 3 SOL+, −0.08 at 5 SOL |
| Single-wallet launches meeting every v2 rule (`npm run traits`) | 31 launches: +3.46 mean, 84% profitable; halves +3.50 and +3.41 |
| Launches meeting every v2 rule, any wallet setup (103 launches, 53 devs) | +4.50 mean, +2.84 median; v1 hours +4.71, fresh hours +4.25 |
| Devs launching for the first time, under the v2 rules | drew buyers 65% of the time, +3.30: a new wallet starts on equal terms |

The rules were found on the same day of data they are scored on; the fresh hours agree, but they were looked at too.
The live shadow test in paper mode is the next real check.

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
| 2 | 2026-10-28 | 5 SOL dev buy; launch within 2 min of the post and first on it; 5 s stall window; website optional; pump.fun IPFS metadata | Round 3: same-dev dev-buy comparison, post speed and order, top devs' sell styles replayed |
| 3 | 2026-10-28 | Source website required (no promo sites); skip farmed accounts; 10 min between launches; 10% sell limit; flow exit up to 3 s of feed lag, else a 15 s timer | Round 5: 334 design and context features tested for replication; sniping, dev-buy sentiment and slippage measured; latency re-measured with 213 ms slots |
| 4 | 2026-10-29 | Pause after 6 dead launches in a row; the follower follows only triggers others buy (1+ SOL in 3 s after the create slot); expectations on real demand only | First live batch: cold-wallet and fingerprint explanations ruled out; half of recorded first launches carried fake demand; pause simulated at the real hit rate |
| 5 | 2026-10-29 | Pause back at 3 dead launches in a row | v4's pause was simulated with independent launches; a wallet's dead launches lower its next ones' chances (drew 44% from a new wallet, 14% after 1–2 dead, 6% after 3+). Five dead launches in a row left our wallet drawing no sniper buy even when first on a 17 s old post |

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
| 2026-10-28 | Buy 5 SOL, not 3 | The same devs made 1.26 SOL a launch more at 5 SOL (90% +0.18 to +2.58); snipers came as often |
| 2026-10-28 | Buy a round amount at 3.000 SOL into the curve or above | 2.917 SOL into the curve was sniped 25% of the time; 3.000, 90% |
| 2026-10-28 | Launch within 30 seconds of the post | Launches on posts under 30 s old made +3.49 a launch, 2–5 min old +1.86 |
| 2026-10-28 | Be first on the post | First launches made +3.11 against +1.57 for later ones on the same post |
| 2026-10-28 | Do not split the sell or keep a moonbag | Top devs' quick splits made 0.65 a launch less than the flow exit on the same coins; the best moonbag plan did no better |
| 2026-10-28 | Use pump.fun's own IPFS for metadata | Snipers skipped the spam tool's launches (45% sniped at 5 SOL) but took ipfs.io's (93%) |
| 2026-10-28 | Replay reactions at our own sell | A moonbag looked better until the dump that follows a dev sell was moved to our first sell |
| 2026-10-28 | Keep the simple exit | Rules per start, a trailing stop and three learned exits all failed to beat v2 on held-out blocks (−0.24 to +0.02 SOL a launch) |
| 2026-10-28 | Speed is for being first | First launches on a post made +3.4 to +4.6 at any post age up to 2 min, +1.6 to +1.8 after |
| 2026-10-28 | Never sell into the sniper wave | Selling at 1–5 s beat v2 on only 25–30% of launches and lost 0.8–1.3 SOL a launch on average |
| 2026-10-28 | Always link the narrative's source as the website | No website: −1.0 to −1.3 SOL a launch in both halves; promo sites drew buyers 24–26% less often on the same post |
| 2026-10-28 | Skip X accounts farmed in the last hour | 3+ launches on the account in the hour before: 12% less often busy, in both halves |
| 2026-10-28 | Space launches 10 minutes apart | The same devs made 0.57 SOL a launch less, with less sniper buying, when launching within 10 min of their last |
| 2026-10-28 | Do not go below 3 SOL; 5 SOL beats 3 | 2–2.95 SOL made 0.48 SOL per SOL put in on strong posts, 5 SOL 0.89; no sign that big dev buys deter traders |
| 2026-10-28 | Name, ticker and description length do not decide much | None of ~60 name, ticker and description features replicated, within the same post or across launches |
| 2026-10-28 | Launch whenever the rules are met; do not wait for an hour or a hot market | The same devs made the same at 01–07 and 19–22 UTC (−0.06, 90% −1.01 to +0.90); no market measure predicted results on held-out blocks; launching at every chance made +15.5 SOL an hour against +9.6 to +11.3 for waiting |
| 2026-10-29 | Leave fake demand out of every comparison | 47–50% of first launches were copy launches or create-slot bundles; without them a 2 SOL first launch made +0.61 to +0.68, not +1.32, and drew buyers 33–37%, not 50% |
| 2026-10-29 | Follow only a launch others are buying | Second launches whose trigger drew 1+ SOL from others in 3 s (create slot left out): +0.74 vs +0.45, in both halves |
| 2026-10-29 | A new wallet is not why snipers stay away | New devs were sniped as often as known ones; at 2 SOL, devs with no earlier launch were sniped 65%, devs with 10+ 39% |
| 2026-10-29 | Pause on 6 dead in a row at a 1-in-3 hit rate | Pausing at 3 halved a session's expected result and doubled the chance of ending down in simulation |
| 2026-10-29 | Check a backtest's demand is real before trusting its size | The +1.32 a launch the follower and the bankroll simulation rested on was half fake demand; the first live batch found it |
| 2026-10-29 | Be first on the post; never launch second | Live, 0 of 4 second launches drew a sniper buy; on one post the first launch drew 11.22 SOL in its first second, ours (19 s later, the same 2 SOL) nothing |
| 2026-10-29 | Neither hold longer nor sell sooner | Real-demand first launches at a 2 SOL bag: every longer hold made 0.03–0.14 SOL a launch less, every sooner sale 0.09–0.16 less, in both halves; a launch dead at 10 s gets 1+ SOL later 3% of the time whether its dev holds or not |
| 2026-10-29 | A wallet's dead launches poison its next ones | Single-wallet real-demand launches at 1.9+ SOL drew buyers 44% from a new wallet, 14% after 1–2 dead, 6% after 3+ dead, 53% after a busy one; v4's pause at 6 assumed independent launches and was reverted |
| 2026-10-29 | Write `createdOn` in the metadata | ipfs.io-hosted real-demand launches with `createdOn: pump.fun` were sniped 59%, without it 10%; all six of our live launches lacked it and none was sniped |

## How the playbook improves

Every day, on the newest data: `npm run daily` runs the checks below and saves them to
`data/reports/daily-<date>.txt`. One at a time:

```bash
npm run simulate -- --folds 4 --horizon 10 --min-dev-buy 2.95   # does the exit still win on held-out blocks?
npm run traits                                                  # do the launch rules still pick the winners?
npm run devs -- --hours 24 --clean                              # has dev behaviour or the 3 SOL step shifted?
npm run export-launches && python3 ml/devbuy.py                 # is 5 SOL still the best dev buy?
python3 ml/sells.py 6 && python3 ml/launchers.py                # how the best devs sell; who launches well; post speed
python3 ml/model.py                                             # does the launch model still beat the rules?
npm run export-paths && python3 ml/exits.py                     # can any exit beat v2 on held-out blocks yet?
python3 ml/opportunities.py                                     # speed, source accounts, chances an hour, dev-buy size
python3 ml/sentiment.py && python3 ml/design.py                 # dev-buy sentiment, sniping; design features that replicate
python3 ml/rulecheck.py                                         # playbook rules side by side, research halves and sealed
python3 ml/timing.py                                            # do clock hours or the market's state matter yet?
npm run postmortem -- --shadow 10                               # the batch review, on recorded launches until ours exist
```

A candidate becomes the next version only if, on held-out blocks, it beats the current one beyond the noise
interval, the owner approves it, and its change, reason and evidence are added above. Once the bot launches, each
batch of its own launches is scored the same way against these expectations, and every loss adds a dated rule.

## The batch post-mortem

`npm run postmortem` reviews the last batch of our launches (default 10) in one screen. It compares what the batch
made with what other devs' launches under the same rules made in the 24 hours before. The gap splits exactly into
three parts, each in SOL a launch:

- **Picking:** our hit rate against theirs. Too few of our launches drew buyers.
- **Coins:** our busy launches, replayed under the playbook's exit, against theirs. Our coins drew less flow once
  they drew any.
- **Execution:** what we made against that replay on the same coins. Late or failed sells, slippage, fees.

It names at most three actions, the biggest gap first, and only for gaps beyond noise. It flags the exit only when a
different plan beats it on the batch beyond noise, and even then the change waits for the daily backtest. It pauses
launching after the playbook's dead-launch streak. Until the bot has launched, `--shadow 10` runs the same review on
recorded launches that match the playbook.
