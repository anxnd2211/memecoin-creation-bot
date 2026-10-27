# Models and market reports

The model scripts in `ml/` read one file: `npm run export-launches` writes every normal, standard-curve launch whose
dev bought in the create transaction to `data/exports/launches.jsonl`. Each launch carries three things:

- **What was known at launch:** dev buy, launch tool, links, the linked post's account and age, ticker wave, and the
  dev's record.
- **What it drew:** outside buying at 1, 3, 10 and 60 seconds, and buyers.
- **How the dev traded, and the replays:** each recorded dev sell, as a share of the bag, plus what the recorded dev,
  each playbook's exit, and the current exit at 1–10 SOL dev buys made in the replay.

Python 3 with `pip install -r ml/requirements.txt`.

| Script | Question | Finding on 2026-10-27 (4,200 launches, 04:22–22:08 UTC with gaps left out) |
| --- | --- | --- |
| `ml/devbuy.py` | How much should the dev buy be? | 5 SOL into the curve. The same devs made +1.26 SOL a launch more at 5 than at 3 SOL (90% +0.18 to +2.58), and snipers came as often. Sniper bots start between 2.917 and 2.954 SOL into the curve |
| `ml/sells.py [hours] [min SOL]` | How do the devs who make money sell? | 55–63% split the bag into about four sells, starting about 5 s after launch and finished within 30 s. 26–29% sell once. Only 4–6% keep a moonbag. Each style is compared with the v2 exit on the same coins: the quick split made 0.65 SOL a launch less |
| `ml/launchers.py [min launches]` | Who launches well, which X accounts' posts become coins, and how fast? | The top fifth of devs mostly used j7tracker (60%), with a median 4.94 SOL dev buy, a post link every time, extra wallets, and a first sell 4 s in. Launches within 30 s of the post made +3.49 a launch, against +0.57 for posts over 6 hours old. The first launch on a post made +3.11, against +1.57 for later ones |
| `ml/model.py [train share]` | From launch-time facts alone, which launches will pay? | Trained on the first 60%, scored on the last 40%. Telling busy launches from dead ones is hard (AUC 0.62 against 0.60 for the dev buy alone). Ranking by expected result works better: the model's top quarter made +3.82 a launch, the v1 rules' top quarter +3.41. The strongest signals are the dev's record, the post's age and the dev buy |

## How these feed the bot

- **Dev buy:** `ml/devbuy.py` re-checks the step daily. Sniper settings are other traders' choices and can move.
- **Narrative engine (Phase 2):** this is a race from post to launch. Watch the accounts whose posts become coins
  that draw buyers (`ml/launchers.py`, section 3a), and launch within 30 seconds, before anyone else on the same post.
  The account list is built from our own feed: each launch's X link names the account and, through the post ID, when
  the post was made, so no X data is needed to rank sources. The X API is for seeing the post as it is made.
- **Launch board:** the model's expected result ranks candidate launches. It becomes a gate only once it beats the
  playbook's rules on a later held-out period by more than the noise.
- **KOLs, whales and top traders:** the observer's wallet intelligence ranks wallets by realised results
  (`npm run report`). The launcher league here ranks devs. A public KOL's X handle maps to their wallet only where
  they publish it themselves. That mapping goes in a hand-kept list, never a scrape.

## What these cannot tell us

- **Selection.** Devs who buy 8–10 SOL made the most per launch, but they were sniped less often (39–48%). Their
  profit came from later buyers, likely their own audiences, so copying the size without the audience would not copy
  the result. The 5 SOL step rests on the same-dev comparison, not on the band averages.
- **Most top launchers use extra wallets around the launch** (bundles). That is outside this project's rules. Only
  the parts of their workflow that a single public wallet can copy are adopted: speed, dev buy size, links, timing,
  and the exit.

## Round 4, 2026-10-28: searching for a better strategy than v2

Research used launches up to 22:31 UTC on 2026-10-27. Launches from 22:35 UTC on were never looked at while
choosing anything; they are kept for the final check (`python3 ml/sealed.py`).

### How much a perfect exit could make

`npm run export-paths` writes each launch's price path with our bag in place of the dev's. Until we sell the whole
bag we do not move the curve, so one path covers every whole-bag exit, and `ml/paths.py` scores any exit as a lookup.
On 1,128 launches with a 2.95+ SOL dev buy:

- **The ceiling.** The best single sell in hindsight made **+4.61 SOL** a launch. v2's exit makes +2.60, 56% of
  that.
- **Where the best moment falls.** For a quarter of launches it is within 2.4 s, when the snipers' buying is the
  top. For 1 in 10 it is after 2 minutes.
- **Where the gap is.** Half of it sits in the top 10% of launches, the runners.

### Smarter exits, tested on held-out time blocks (`ml/exits.py`)

Each exit was chosen or trained on three time blocks, then scored on the fourth, in turn (1,128 launches with a
2.95+ SOL dev buy). Results are SOL a launch against v2 on the same launches, with 90% intervals:

| Exit | Result vs v2 |
| --- | --- |
| Rules per start: a flow exit tuned separately for launches with low, middle and high buying in their first 3 s | +0.02 (−0.05 to +0.10) |
| Trailing stop: v2 until the bag is up 25–100%, then sell when the gain falls back 20–50% | −0.06 (−0.09 to −0.02) |
| Learned exit (gradient boosting, 22 live features): sell when holding on is predicted to add nothing | −0.24 (−0.35 to −0.13) |
| Learned, only allowed to sell before v2 would | −0.24 (−0.32 to −0.17) |
| Learned, only allowed to hold past v2's sell | −0.06 (−0.14 to +0.02) |
| Simple rule: sell into the snipers at 2 s when the first 2 s brought 3–12 SOL and buying has paused | −0.06 to −0.47 |

Nothing beat v2 on launches it was not fitted on. The gap to the ceiling is real, but it does not show in time:

- **The sniper-peak quarter.** Their buying looks the same in the first seconds as on launches that keep going.
  Selling at 1–5 s wins on only 25–30% of launches.
- **The runners.** Every rule that holds on for them gives back more on the launches that stall.

v2's exit stays. It was picked from 1,800 plans and checked against five smarter alternatives.

### Final check on sealed launches

Launches from 22:35 to 22:50 UTC were never looked at while choosing anything (`python3 ml/sealed.py`). That is a
small sample:

- **Exit:** v2 made +5.48 a launch against +3.93 for the recorded devs (+1.55, 90% +0.79 to +2.39; 76 launches).
- **Launches meeting every v2 rule:** 16 launches, +4.73 mean, 88% profitable. Research predicted +4.50.
- **Snipers:** 93% of 5 SOL launches were sniped.

### Launch side (`ml/opportunities.py`)

- **Be first; seconds after that matter little.** The first launch on a post made +3.5 to +4.6 SOL a launch at our
  5 SOL size whether the post was 0 seconds or 2 minutes old (+3.98 at 0–3 s, +3.41 at 1–2 min). It fell to
  +1.6–1.8 after 2 minutes. Speed buys being first; v2's "within 2 minutes and first" rule is the right cut.
- **Source accounts help a little.** Ranked only by their record before each post, accounts with 3+ earlier launches
  and 60%+ busy made +4.50 a launch on hours the ranking never saw, against +2.68 for weak ones and +3.36 for
  accounts never seen before. The intervals overlap: rank by it, do not gate on it.
- **Chances.** About 42 posts an hour got a first launch in the sniper band from someone. At one launch at a time
  with the bag sold within 2 minutes, the limit is winning the race to the post, not SOL.

### Dev-buy size (`ml/devbuy.py` and the sizing mix)

With the same outside flow, a bigger bag takes more: +3.26 at 5 SOL and +4.99 at 10 SOL on sniped launches. But
sniper bots come less often above about 6 SOL: 81% at 5 SOL (78 devs), 74% at 7 SOL (9 devs), 53% at 10 SOL
(19 devs). Weighting the two by those odds gives the expected result for each size:

| Dev buy | Expected SOL a launch |
| --- | --- |
| 3 SOL | +1.94 |
| 5 SOL | +2.79 |
| 7 SOL | +3.23 |
| 10 SOL | +3.15 |

7 SOL may beat 5, but its sniper odds rest on 9 devs. 5 SOL stays until `ml/devbuy.py` shows the 6–8 SOL odds on
30+ devs.

## Round 5, 2026-10-28: dev buy, sniping, and the best coin on the best post

| Script | Question | Finding (research launches, 04:22–22:31 UTC) |
| --- | --- | --- |
| `ml/sentiment.py` | Do big dev buys scare traders, does dumping hurt a dev, what does sniping do? | Bigger buys drew more organic buyers after 10 s, not fewer. A dumping record did not cost devs their snipers. The most-sniped quarter of launches made +5.06 SOL each, the least-sniped +1.55 |
| `ml/design.py` | Which name, ticker, description, website and context features make a coin draw buyers? | 334 tests, each required to replicate in both halves (about 0.4 would pass by luck). Five did: a missing website and a promo site hurt; a dev's earlier busy launch helps; X accounts farmed in the hour before hurt. No name, ticker or description feature replicated |
| `ml/rulecheck.py` | v2 against v3 rules, by period | v3 beat v2 in both research halves at 5 SOL (+5.69 vs +5.06, +5.63 vs +3.89). The sealed hours have too few v3 launches yet |

What this means for the coin designer: what can be measured from pump.fun alone is about *which post* and *how
fast*, not wording. Of the design choices, only the website (link the source) showed. Post content (text, media,
the author's reach, likes in the first minute) needs the X API and is the next set of features to test.

## Round 6, 2026-10-28: when to launch (`ml/timing.py`)

The recording covers 14 of the 24 UTC hours (01–07, 11–12, 19–23), all on one Tuesday. Bitquery's public snapshot
puts pump.fun's busiest launch hours at 15:00–22:00 UTC, peaking at 20:00. That counts launches (crowding), not
successful ones.

- **Clock hour: no effect for the same dev.**
  - Across devs, launches made at 01–07 UTC made +3.66 SOL a launch (83% sniped) against +2.52 at 19–22 UTC (66%
    sniped).
  - The 32 devs who launched in both windows made the same in each: evening minus early −0.06 SOL (90% −1.01 to
    +0.90), and the same sniped share.
  - The hours differ in who launches then, not in what a launch gets.
- **Market state before a launch: no effect.** Eleven measures were tested: trading volume, traders and trades in
  the last 10 minutes, launches in the last 10 and 60, the Mayhem share, the share of recent launches that drew
  buyers, graduations, the volume trend, sniper buying on recent 3 SOL+ launches, and what the exit made on launches
  10–70 minutes earlier. None ranked results the same way in both halves of the hours. Models built on them ranked
  held-out blocks slightly backwards (−0.07 to −0.11).
- **Timing policies, simulated** on first-on-post chances with 10 minutes between launches:

  | Policy | Launches | SOL a launch | SOL an hour |
  | --- | --- | --- | --- |
  | Every chance | 26 | +4.23 | +15.5 |
  | Only when the market model, fitted on other blocks, is above its median | 17 | +4.73 | +11.3 |
  | Only above its 25th percentile | 21 | +3.24 | +9.6 |

  Waiting for a better market loses launches without reliably making each one better.
- **Chances never ran out.** Every recorded hour had 20–76 first-on-post chances in the 3–5 SOL band, far more than
  the 6 an hour that 10-minute spacing allows. The busiest hours (20–21 UTC) had the most.

**What this means:** the timing that matters is relative to the post (within 2 minutes, first on it) and to our
last launch (10 minutes). The clock and the market's mood did not matter here. Run the bot whenever the owner can
approve launches.

**What is still unknown:**

- The 10 unrecorded hours (00, 08–10, 13–18 UTC), including most of the 15:00–22:00 UTC peak.
- Days of the week.

`python3 ml/timing.py` re-runs this; it needs a week of continuous recording to answer these.
