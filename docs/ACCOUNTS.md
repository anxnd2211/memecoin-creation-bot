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
| Faster stream, step 1 | **Helius Developer** ($49/month: 10M credits, 50 requests/s, Enhanced WebSockets with full transactions, staked sends) | Removes the public RPC's 1–35 s lag and throttling; full transactions show the real trader behind pooled routers. Enough for paper mode |
| Faster stream, step 2 | **Helius Business** ($499/month: 100M credits, 200 requests/s, LaserStream gRPC on mainnet) | Sub-second gRPC with replay after disconnects. Needed for live launches if the feed lag on Developer stays over 2 s, because the v2 exit falls back to a timer beyond that. Streaming is metered (2 credits per 0.1 MB, and all of pump.fun is roughly 0.5–1.5 MB/s), so watch the credit dashboard in week one |
| Flat-price alternative | A dedicated Yellowstone gRPC node (Triton One, Chainstack and others; dedicated Solana nodes are listed from about $2,900/month) | Cheaper than metered streaming if volume makes credits expensive |
| Price data | A Jupiter API key (portal.jup.ag) | The free lite price API rate-limits at our volume (HTTP 429 seen); used to value trades in USDC, tokenized stocks and other quote assets |
| 24/7 host | A Linux server near your RPC provider's region (Frankfurt, Amsterdam or New York): 8+ cores, 32 GB RAM, 1 TB NVMe | This Mac sleeps and runs on battery. On a server set `STORE_TRADES=all` and longer retention |

### Getting the Helius key

1. Go to dashboard.helius.dev and sign up (email, Google, GitHub or a Solana wallet). A free key is created at once.
2. Open **Billing** (or **Plans**), choose **Developer**, and pay by card or crypto. Plans are monthly, cancel any
   time; extra credits cost $5 per million.
3. Open **API Keys**, copy the **Mainnet** RPC URL and the WebSocket URL. Optionally restrict the key to this
   machine's IP under the key's settings.
4. Copy `.env.example` to `.env` and set `SOLANA_RPC_HTTP` and `SOLANA_RPC_WS` to those URLs, with the key inside
   them. Do this yourself in an editor: never paste the key into chat.
5. Restart the observer (`npm run observe`). The log shows the feed lag; tell me the numbers and I will switch the
   observer to full transactions.

## Phase 2 — narrative engine and coin designer

| Need | What to get | `.env` key |
| --- | --- | --- |
| Claude API | API key from console.anthropic.com, with a monthly spend limit set | `ANTHROPIC_API_KEY` |
| X (Twitter) data | X developer account (console.x.com) on pay-per-use, the default since February 2026: $0.005 per post read, $0.01 per user lookup, up to 3 million post reads a month. Used to see posts from the source accounts the moment they are made (the playbook launches within 30 s of a post). Our own feed already ranks the accounts, from launches' X links, at no cost | `X_BEARER_TOKEN` |
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

Playbook v2 ([PLAYBOOK.md](PLAYBOOK.md)) buys 5 SOL at launch: the same devs made more at 5 SOL than at 3, and on
a normal curve the dev position can lose at most the fees. The bag is sold 10 seconds to 2 minutes after launch, so
launches run one at a time reuse the same SOL.

| Item | Per launch | Batch of 10, one launch at a time |
| --- | --- | --- |
| Dev buy, returned when the bag is sold within 2 minutes | 5.06 SOL | 5.06 SOL, reused |
| Most the dev position can lose on a normal curve (protocol fee both ways) | about 0.10 SOL | about 1.0 SOL |
| Rent and network fees for the create transaction (on the fork: 0.0091 SOL on the first launch, 0.0071 after) | about 0.01 SOL | about 0.1 SOL |
| Priority fees or tips for the create and the sell | about 0.005–0.02 SOL | up to 0.2 SOL |
| Reserve for retries, a failed sell, and claiming creator fees | | about 1.5 SOL |
| **Wallet funding** | | **about 8 SOL** |

If none of the ten launches draws a buyer, the batch loses about 1.2–1.4 SOL: the fees, rent and tips above. The
bound holds only for normal-mode launches whose whole bag is sold; a bug that leaves a bag unsold, or a stolen key,
can lose more, which is why the wallet holds one batch at a time. Running launches in parallel needs 5 SOL for each
open position.

## What stays with you

- Creating accounts, entering passwords and accepting provider terms.
- Holding the launch wallet's keys and approving every launch.
- Setting spend limits on each paid API.
