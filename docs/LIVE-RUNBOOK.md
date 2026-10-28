# Live runbook: the first real launches

This is the checklist for the first live session. Every launch uses the owner's wallet and waits for the owner's
Approve on Telegram; the bot never launches on its own. Not financial advice: only fund the launch wallet with SOL
you can afford to lose entirely.

## Start here

1. **Accounts and keys** (about 30 minutes; the table under "Before the session" has the steps). Put each in `.env`,
   never in chat:
   - a Helius key (Developer plan)
   - a Telegram bot token and your chat id
   - a Pinata JWT
   - a new launch wallet, funded with about 8 SOL
   - optionally, an X API bearer token
2. **Two terminals:**
   - `caffeinate -i npm run observe`, left running for the whole session
   - `npm run doctor`, until it shows no FAIL
3. **Rehearse:**
   - `npm run live -- --mode fork`: a full launch on the local pump.fun copy
   - `npm run live -- --mode dry`: real feed and Telegram, nothing sent; try `/launch <post url>` with a photo and
     approve the card
4. **Go live:** `npm run live -- --mode live`. Launch one coin, watch it sell, check the wallet, then continue.
   `/kill` stops everything.
5. **After the batch:** `npm run postmortem -- --mode live`.

## What the bot does on each launch (playbook v3)

1. **A candidate post arrives.** The X watcher streams it from a watched account, or you send it yourself as a
   photo with the caption `/launch <post url>`. With just the link, the ticker and name are drafted from the post's
   text. To choose them yourself, use `/launch <post url> | <TICKER> | <Name> | <source url>`.
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
| Launch wallet | A new wallet used only for launches. With the Solana CLI: `solana-keygen new -o ~/.config/memecoin/launch.json`, then `chmod 600` that file | `.env`: `LAUNCH_KEYPAIR_PATH` |
| Fund it | About 8 SOL (5.06 dev buy, reused each launch, plus fees, rent and a reserve) | — |
| Pinata (metadata hosting) | pinata.cloud, free plan, then API Keys, New Key with the pinning scopes, copy the **JWT**. pump.fun's own upload sits behind a Cloudflare bot check, which the bot does not work around. Metadata is pinned on your account and linked as `https://ipfs.io/ipfs/<cid>`, the way pump.fun's site links it | `.env`: `PINATA_JWT` |
| Optional: X API | console.x.com, pay-per-use, bearer token. Enables the X watcher: a new post from one of the 40 watched accounts becomes a ready launch card within seconds. Without it, send posts by hand | `.env`: `X_BEARER_TOKEN` |

Never paste a key, token or seed phrase into chat. Put them only in `.env`, which git ignores.

## The session, in order

Each step must pass before the next:

```bash
npm run doctor                              # every key, service, balance and the feed's lag checked; no secrets printed
npm test                                    # all tests pass
npm run grind -- --count 20                 # mint addresses ending in "pump", like the site's (about 2-3 min each)
npm run live -- --mode fork                 # one launch end to end on the local pump.fun copy, a real launch's traders replayed
npm run shadow -- --minutes 30              # the exit manager live on other devs' 5 SOL launches
npm run live -- --mode dry                  # real feed, real Telegram, launches simulated against mainnet, nothing sent
npm run live -- --mode live                 # real launches, each one approved by you on Telegram
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
- **If a sell fails three times,** the bot alerts you on Telegram. Sell manually at once, in the pump.fun site or
  any wallet: an unsold bag is the one way to lose more than the fees.

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
