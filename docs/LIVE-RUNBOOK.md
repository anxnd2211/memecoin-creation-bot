# Live runbook: the first real launches

This is the checklist for the first live session. Every launch uses the owner's wallet and waits for the owner's
Approve on Telegram; the bot never launches on its own. Not financial advice: only fund the launch wallet with SOL
you can afford to lose entirely.

## Start here

1. **Accounts and keys** (about 30 minutes; the table under "Before the session" has the steps). Put each in `.env`,
   never in chat:
   - a Helius key (Developer plan), and Helius Sender for landing launches and sells (`SENDER_URL`)
   - a Telegram bot token and your chat id
   - a Pinata JWT with the pinFileToIPFS and pinJSONToIPFS scopes
   - a new launch wallet, funded with about 8 SOL, as an absolute path in `LAUNCH_KEYPAIR_PATH`
   - a separate test wallet with about 0.3 SOL, for the smoke test
   - optionally, an X API bearer token
2. **Two terminals:**
   - `caffeinate -i npm run observe`, left running for the whole session
   - `npm run doctor -- --pin`, until it shows no FAIL (`--pin` uploads a tiny test file to check the whole metadata
     path)
3. **Rehearse:**
   - `npm run live -- --mode fork`: a full launch on the local pump.fun copy
   - `npm run live -- --mode dry`: real feed and Telegram, nothing sent; try `/launch <post url>` with a photo and
     approve the card
4. **Smoke test:** point `LAUNCH_KEYPAIR_PATH` at the test wallet, clear `LAUNCH_PUBKEY` (or set it to the test
   wallet), and run `npm run live -- --mode live --smoke`. It refuses a wallet holding over 1 SOL. Send one fresh post with `/launch`. One real launch goes out with a 0.1 SOL
   dev buy (about 0.012 SOL of cost) and is sold. That proves the keys, Pinata, Telegram, landing, the live exit, the
   sell and the accounting on mainnet. Use a separate wallet because snipers hold a dead launch in a wallet's history
   against it.
5. **Go live:** stop the smoke run (only one launcher runs at a time), point `LAUNCH_KEYPAIR_PATH` back at the launch
   wallet and run `npm run live -- --mode live`. Launch one coin, watch it sell, check the wallet, then continue.
   `/kill` stops everything.
6. **After the batch:** `npm run postmortem -- --mode live`.

## A smaller launch wallet

The playbook buys 5 SOL and wants about 8 SOL in the wallet. With less, start the launcher with `--dev-buy`
(`python3 ml/smallwallet.py <wallet SOL>` re-runs the analysis):

| Wallet | Use | Why |
| --- | --- | --- |
| About 2.2–3 SOL | `--dev-buy 2` or `--dev-buy auto` | Sniper bots answer exactly 2.000 SOL into the curve (sniped 74–79% of the time, against 12–57% for 1.95–2.4 SOL). Strong-post launches at 2 SOL made +1.24 SOL each by others' records; a dead one costs about 0.05 SOL. With 2.5 SOL the wallet can lose about 0.33 SOL to dead launches before it can no longer pay for one |
| About 3.2–3.5 SOL | `--dev-buy 2`, not 3 | 3 SOL needs 3.19 SOL in the wallet, so one dead launch strands it; in simulation a 3.25 SOL wallet buying 3 SOL ended at a loss 37% of the time when our hit rate was half of theirs |
| About 8 SOL | the default (5 SOL) | 5 SOL made the most per launch and per SOL |

`--dev-buy auto` buys 2 SOL until the wallet holds 5.0625 + 0.15 reserve + 0.3 buffer = 5.51 SOL, then 5 SOL. Every
size is an exact sniper tier (2, 3, 4 or 5 SOL into the curve); amounts in between draw fewer snipers.

## Full automation: where candidates come from

Your only action is the Approve tap. Candidates reach the bot three ways, best first:

| Source | Needs | How fast | What you do |
| --- | --- | --- | --- |
| **Launch-follower** (`--follow`) | nothing | ours is the 2nd launch on the post, seconds after the 1st; +1.1 SOL a launch at a 2 SOL bag on recorded data | tap Approve |
| **X watcher** | an X API key in `.env` (console.x.com, pay-per-use) | ours is often the 1st launch (+1.3) | tap Approve |
| **/launch by hand** | you watching X | depends on you | send the post, tap Approve |

The follower works because other devs' bots watch X around the clock: the first launch on a post proves the post
exists, and second launches do nearly as well as first ones. Start the bot with:

```bash
npm run live -- --mode live --follow --dev-buy auto
```

## Watching it live: the dashboard

`npm run dashboard` serves a read-only page at http://localhost:8788 that shows the whole session at a glance:
wallet balances, today's P&L against the daily limits, the dead streak and the launch cooldown, every launch with
its result and links (pump.fun chart, the Solscan transaction, the source post), the market's launch rate, and the
observer's smart-money signals. An amber banner marks a bag in flight; red marks the kill switch. It opens the
database read-only and holds no keys: the page cannot launch, sell or approve anything, so it is safe to leave open
during a session. To watch from a phone on the same Wi-Fi, run `npm run dashboard -- --host 0.0.0.0` and open
`http://<the Mac's IP>:8788` — anyone on that network can then see it, so keep that to networks you trust.
Extra wallets appear via `DASHBOARD_WALLETS=label:pubkey,...` in `.env` (public keys only).

## What the bot does on each launch (playbook v3)

1. **A candidate post arrives.** The launch-follower spots it from the first launch on the post, the X watcher
   streams it from a watched account, or you send it yourself as a photo with the caption `/launch <post url>`. With
   just the link, the ticker and name are drafted from the post's text. To choose them yourself, use
   `/launch <post url> | <TICKER> | <Name> | <source url>`.
2. **The coin is drafted:** name, ticker, image and description; the X link is the post; the website is the
   narrative's source. A compliance check runs.
3. **The launch board runs**, every gate failing closed:
   - the kill switch is off, and the post is at most 2 minutes old;
   - the observer is current, and no launch links the post yet;
   - the account is not farmed, and the ticker is not crowded;
   - the website is the source, and compliance passes;
   - 10 minutes since our last launch, and the daily launch and loss limits are not hit;
   - fewer than 3 dead launches in a row, and the wallet balance covers the buy;
   - the preflight simulation passes;
   - you approve.
4. **The launch transaction:** `create_v2` (normal mode) plus a 5 SOL dev buy, simulated against mainnet first,
   then sent.
5. **The exit manager watches the coin's trades live.** After at least 10 s, it sells the whole bag once other
   wallets' net buying over 5 s is 0.5 SOL or less, and at 2 minutes at the latest. If the feed lags more than 3 s,
   it sells at 15 s. If the curve nears completion (graduation), it sells at once. The sell is limited to 10% below its quote and is re-quoted and retried if it fails.
6. **The result is recorded** in `our_launches`. Creator fees can be claimed with `/claim`.

## Before the session

| Step | What to do | Where it goes |
| --- | --- | --- |
| Keep the Mac awake and plugged in | Lid open, on power. Or run on a server | — |
| Observer running | `caffeinate -i npm run observe`, left running the whole session | — |
| Helius key | dashboard.helius.dev, Developer plan, copy the mainnet RPC and WebSocket URLs (see [ACCOUNTS.md](ACCOUNTS.md)); restart the observer | `.env`: `SOLANA_RPC_HTTP`, `SOLANA_RPC_WS` |
| Telegram bot | In Telegram, message @BotFather, send `/newbot`, copy the token. Send your new bot any message, then open `https://api.telegram.org/bot<TOKEN>/getUpdates` in a browser and copy `message.chat.id` | `.env`: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` |
| Launch wallet | A new wallet used only for launches. With the Solana CLI: `solana-keygen new -o ~/.config/memecoin/launch.json`, then `chmod 600` that file. Write its full path in `.env` (for example `/Users/you/.config/memecoin/launch.json`; a leading `~` also works) | `.env`: `LAUNCH_KEYPAIR_PATH` |
| Helius Sender | Sends each launch and sell over staked routes with a tip (0.001 SOL by default; successful devs tip about 0.005). Use `https://sender.helius-rpc.com/fast?api-key=<your Helius key>` | `.env`: `SENDER_URL`, optionally `SENDER_TIP_LAMPORTS` |
| Fund it | About 8 SOL (5.06 dev buy, reused each launch, plus fees, rent and a reserve) | — |
| Pinata (metadata hosting) | pinata.cloud, free plan, then API Keys, New Key with the legacy pinning scopes pinFileToIPFS and pinJSONToIPFS, copy the **JWT**. pump.fun's own upload sits behind a Cloudflare bot check, which the bot does not work around. Metadata is pinned on your account and linked as `https://ipfs.io/ipfs/<cid>`, the way pump.fun's site links it | `.env`: `PINATA_JWT` |
| Optional: X API | console.x.com, pay-per-use, bearer token. Enables the X watcher: a new post from one of the 40 watched accounts becomes a ready launch card within seconds. Without it, send posts by hand | `.env`: `X_BEARER_TOKEN` |

Never paste a key, token or seed phrase into chat. Put them only in `.env`, which git ignores.

## The session, in order

Each step must pass before the next:

```bash
npm run doctor -- --pin                     # every key, service, balance, the feed's lag and the metadata upload; no secrets printed
npm test                                    # all tests pass
npm run live -- --mode fork                 # one launch end to end on the local pump.fun copy, a real launch's traders replayed
npm run shadow -- --minutes 30              # the exit manager live on other devs' 5 SOL launches
npm run live -- --mode dry                  # real feed, real Telegram, launches simulated against mainnet, nothing sent
npm run live -- --mode live --smoke         # one real 0.1 SOL launch from the test wallet
npm run live -- --mode live                 # real launches from the launch wallet, each one approved by you on Telegram
npm run postmortem -- --mode live           # after the batch
```

## During the session

- **Approve or reject each card within 30 seconds.** No answer is a rejection. After you approve, the bot checks
  the post's age and first-on-post again before sending.
- **Stop everything:** send `/kill` on Telegram, or run `touch data/KILL`. While killed, a bag already held is still
  sold. `/resume` turns it off.
- **Hard limits** (`src/live/board.ts`, `DEFAULT_LIMITS`): 10 launches a day, stop after −1.5 SOL in a day, at most
  5.1 SOL per dev buy, 0.15 SOL kept in reserve, and a pause after 3 dead launches in a row.
- **If the bot stops mid-launch** (a crash, a restart, the Mac sleeping), start it again: it first sells any bag a
  launch left behind, and pauses launching if one cannot be sold.
- **Creator fees** pile up in the wallet's creator vault; `/claim` moves them to the wallet (simulated first).
- **If a sell fails,** the bot pauses launching, tells you, and keeps selling in rounds with wider limits; after four
  rounds it asks you to sell by hand. If it does, sell at once on the pump.fun site or in any wallet: an unsold bag
  is the one way to lose more than the fees. The record then shows the bag as lost until a restart's recovery sells
  it.
- **The mint-address pool** holds 20 ground "pump" addresses, enough for two days at 10 launches a day. Grinding more
  (`npm run grind`) takes about an hour on all cores, so do it outside a session.

## What to expect

- **Launches meeting every v3 rule** (other devs, research hours): +5.6 SOL each in both research halves. On the
  sealed hour 22:35–23:46 UTC, never used in research: +6.62 on 4 launches.
- **The exit on the sealed hour:** +0.89 SOL a launch better than what the recorded devs did (275 launches).
- **A dead launch** costs about 0.11 SOL: 0.095 of trading fees on the 5 SOL buy and sell (the most a whole-bag sell
  can lose), 0.009 of rent and 0.002 of tips. Successful 5 SOL devs land their launches with a 0.005 SOL Jito tip (60%
  of them) and almost no priority fee; `SENDER_TIP_LAMPORTS` sets ours (default 0.001 SOL).
- **A batch of 10** (`python3 ml/batch.py 10 single`, replays of single-wallet launches that met the rules):

  | Our hit rate vs theirs | Typical total | 5th percentile | Chance of a loss |
  | --- | --- | --- | --- |
  | Same as theirs | +35 SOL | +20 | 0% |
  | Half of theirs | +19 SOL | +6 | 0.1% |
  | A quarter of theirs | +10.5 SOL | +1 | 2.3% |

  These replay other devs' coins, timing and buyers. They are what the strategy did, not what it will do.
- **The unknown is our own hit rate.** Our coins, our timing and our wallet's record decide it. The first batch of
  10 measures it, and the post-mortem says where any gap comes from.
