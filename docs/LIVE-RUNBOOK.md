# Live runbook: the first real launches

This is the checklist for the first live session. Every launch uses the owner's wallet and waits for the owner's
Approve on Telegram; the bot never launches on its own. Not financial advice: only fund the launch wallet with SOL
you can afford to lose entirely.

## What the bot does on each launch (playbook v3)

1. **A candidate post arrives.** Either the X watcher streams it from a watched account, or you send
   `/launch <post url> | <TICKER> | <Name> | <source url>` with a photo.
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
   wallets' net buying over 5 s is 0.5 SOL or less, and at 2 minutes at the latest. If the feed lags more than 2 s,
   it sells at 20 s. The sell is limited to 10% below its quote and is re-quoted and retried if it fails.
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
| Optional: X API | console.x.com, pay-per-use, bearer token. Enables the X watcher; without it, send posts by hand | `.env`: `X_BEARER_TOKEN` |

Never paste a key, token or seed phrase into chat. Put them only in `.env`, which git ignores.

## The session, in order

Each step must pass before the next:

```bash
npm test                                    # all tests pass
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
- **If a sell fails three times,** the bot alerts you on Telegram. Sell manually at once, in the pump.fun site or
  any wallet: an unsold bag is the one way to lose more than the fees.

## What to expect

- **Launches meeting every v3 rule** (other devs, research hours): +5.6 SOL each in both research halves. On the
  sealed hour 22:35–23:46 UTC, never used in research: +6.62 on 4 launches.
- **The exit on the sealed hour:** +0.89 SOL a launch better than what the recorded devs did (275 launches).
- **A dead launch** costs about 0.12 SOL: fees, rent and the tip.
- **The unknown is our own hit rate.** Our coins, our timing and our wallet's record decide it. The first batch of
  10 measures it, and the post-mortem says where any gap comes from.
