# Accounts, subscriptions and credentials

What the bot needs, by phase. You create the accounts and put keys in `.env` yourself (copy `.env.example`).
Nothing here should ever be pasted into chat: no passwords, cookies, session tokens, seed phrases or private keys.

Prices change often; the figures below were checked in October 2026 and should be confirmed on each provider's
pricing page before you subscribe.

## Screening new pump.fun coins: nothing needed

pump.fun's "New" tab is a view of on-chain launch events. The observer reads those events straight from Solana, so
it already records every new coin, every trade, the dev's buys and sells and the creator fees, with no login,
cookie or permission. To screen more and better, it needs only:

- to keep running (a 24/7 server, or this Mac plugged in and awake), and
- a paid stream (below), so no events are lost when the free public RPC lags or disconnects.

## Phase 1 — observer and wallet intelligence (running now)

It runs on the free public Solana RPC. Measured on 2026-10-27: median latency swings between about 1 s and 35 s,
and the websocket drops several times an hour, losing the events in each gap (gaps hid at least two graduations from
the feed). Transaction lookups are throttled to a few per minute. **A paid stream is required for seconds-level wallet
intelligence.**

| Need | Recommendation | Why |
| --- | --- | --- |
| Faster, gap-free stream | **Helius Business** (about $499/month). Since April 2026 it includes LaserStream gRPC (up to 10 connections) and Enhanced WebSockets | Sub-second latency, replay after disconnects, no public rate limits. Streaming is metered at 2 credits per 0.1 MB, and all of pump.fun is roughly 0.5–1.5 MB/s, so watch the credit dashboard in week one |
| Flat-price alternative | A dedicated Yellowstone gRPC node (Triton One, Chainstack and others; dedicated Solana nodes are listed from about $2,900/month) | Cheaper than metered streaming if volume makes credits expensive |
| Price data | A Jupiter API key (portal.jup.ag) | The free lite price API rate-limits at our volume (HTTP 429 seen); used to value trades in USDC, tokenized stocks and other quote assets |
| 24/7 host | A Linux server near your RPC provider's region (Frankfurt, Amsterdam or New York): 8+ cores, 32 GB RAM, 1 TB NVMe | This Mac sleeps and runs on battery. On a server set `STORE_TRADES=all` and longer retention |

## Phase 2 — narrative engine and coin designer

| Need | What to get | `.env` key |
| --- | --- | --- |
| Claude API | API key from console.anthropic.com, with a monthly spend limit set | `ANTHROPIC_API_KEY` |
| X (Twitter) data | X developer account on pay-per-use (the default since February 2026). Reads are about $0.005 per post; filtered stream on pay-per-use is limited (reported 1 connection, 1,000 rules). Full firehose is Enterprise only. This covers tracked accounts, keyword rules and pump.fun's own account (@pumpdotfun) | `X_BEARER_TOKEN` |
| Image generation | One provider for coin art: OpenAI Images, Google Imagen, or Flux via fal.ai or Replicate. We pick one after testing quality | `IMAGE_API_KEY` |
| Market trending | DexScreener and Jupiter public APIs: free, no key | — |

### Third-party trading tools

These need no cookies, logins or session tokens from you, and the bot should not use them that way.

- **j7tracker.** What you pasted alongside the username and password is not a client ID. It is a login session
  token that grants your account's access for 12 hours from your IP address. The bot won't sign in with your
  password or use that token. Both are now in this conversation's history, so change the j7tracker password and
  sign out other sessions. If j7tracker offers subscribers an official API key, webhook or websocket for its tweet
  feed, put that key in `.env` (`J7TRACKER_API_KEY`) and the bot can read it; ask their support. Otherwise the X
  API above delivers the same tweets from the source.
- **Axiom.** Axiom has no official public API; the unofficial SDKs work by reusing a logged-in browser's
  `auth-access-token` and `auth-refresh-token` cookies, which hand over your account. Not needed: for pump.fun,
  Axiom's Pulse and Discover views are built from the same on-chain events our observer decodes directly, with
  less delay. Axiom's X tracker is X data, which the X API covers. The other chains in that link (BNB, Base,
  Robinhood and so on) are outside this project.
- **pump.fun's X account.** Read through the X API (`X_BEARER_TOKEN`); no cookie needed. pump.fun's website also
  uses public, unauthenticated (but undocumented) JSON endpoints for trending and featured coins, which the
  narrative engine can poll at a low rate.

## Phases 3–4 — launcher and live launches

| Need | What to get | Notes |
| --- | --- | --- |
| Launch wallet | A new Solana wallet used only for launches, made on the machine that runs the bot (for example `solana-keygen new -o ~/keys/launch.json`) | One public wallet that is both creator and signer on every launch. `.env` holds only the keypair's path (`LAUNCH_KEYPAIR_PATH`); the file stays on that machine with owner-only permissions. Fund it with one batch's budget at a time and sweep profits to your main wallet |
| Transaction landing | Helius staked sending (included in paid plans) or Jito bundles | Gets create and sell transactions in within the same few seconds the screen shows matter |
| Approvals and alerts | Telegram bot from @BotFather (free) | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`. See below |
| Coin socials (optional) | A real X account you own and run for a project | No bot or sockpuppet accounts. Posting through the API needs X write access |

### What the Telegram bot is for

It is our own control channel, not a trading bot:

- **Approvals:** each proposed launch arrives as its dossier (name, art, narrative evidence, crowding count, dev
  buy, exit plan) with Approve and Reject buttons. Nothing launches without your tap.
- **Live alerts:** launch confirmed, each tranche sold, moonbag kept, stop triggered, observer down or lagging.
- **Kill switch:** one command stops new launches and, if you choose, exits open positions.
- **Reports:** a daily summary and each batch post-mortem.

Exit sells under an approved plan run automatically, because they have to land within seconds of the inflow that
triggers them. Third-party Telegram trading bots (Trojan, BonkBot and similar) are not needed; they hold your keys
on their servers.

### SOL for the first live batch (arithmetic, not advice)

This is the cost structure of the test plan, not investment advice, and I am not a licensed financial adviser.
Only fund the launch wallet with SOL you can afford to lose entirely.

The backtest ([EXIT-BACKTEST.md](EXIT-BACKTEST.md)) changed this plan: launches with a dev buy under 1 SOL drew
almost no buyers, while about 3 SOL drew the sniper bots. It also showed that on a normal curve the dev position can
lose at most the fees, and that the bag is sold about 20 seconds after launch, so launches run one at a time can
reuse the same SOL.

| Item | Per launch | Batch of 10, one launch at a time |
| --- | --- | --- |
| Dev buy, returned when the bag is sold about 20 s later | 3 SOL | 3 SOL, reused |
| Most the dev position can lose on a normal curve (protocol fee both ways) | about 0.06 SOL | about 0.6 SOL |
| Rent and network fees for the create transaction (measured: 0.010 and 0.025 SOL) | about 0.02 SOL | about 0.2 SOL |
| Priority fees or tips for the create and the sell | about 0.005–0.02 SOL | up to 0.2 SOL |
| Reserve for retries, a failed sell, and claiming creator fees | | about 1 SOL |
| **Wallet funding** | | **about 5 SOL** |

If none of the ten launches draws a buyer, the batch loses about 1 SOL: the fees, rent and tips above. The bound
holds only for normal-mode launches whose whole bag is sold; a bug that leaves a bag unsold, or a stolen key, can
lose more, which is why the wallet holds one batch at a time. Running launches in parallel needs 3 SOL for each open
position.

## What stays with you

- Creating accounts, entering passwords and accepting provider terms.
- Holding the launch wallet's keys and approving every launch.
- Setting spend limits on each paid API.
