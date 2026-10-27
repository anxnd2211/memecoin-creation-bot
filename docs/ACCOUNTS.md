# Accounts, subscriptions and credentials

What the bot needs, by phase. You create the accounts and put keys in `.env` yourself (copy `.env.example`).
Nothing here should ever be pasted into chat: no passwords, cookies, seed phrases or private keys.

Prices change often; the figures below were checked in October 2026 and should be confirmed on each provider's
pricing page before you subscribe.

## Phase 1 — observer and wallet intelligence (running now)

Nothing is required to try it: it runs on the free public Solana RPC. Measured on 2026-10-27: ~1.2 s median
latency in short runs, but over 20-minute runs the public RPC throttles a full pump.fun stream and median latency
swings between 2 s and 60 s, with occasional websocket refusals. **A paid stream is required for seconds-level
wallet intelligence.** What a subscription buys:

| Need | Recommendation | Why |
| --- | --- | --- |
| Faster, gap-free stream | **Helius Business** (about $499/month). Since April 2026 it includes LaserStream gRPC (up to 10 connections) and Enhanced WebSockets | Sub-second latency, replay after disconnects, no public rate limits. Streaming is metered at 2 credits per 0.1 MB, and all of pump.fun is roughly 0.5–1.5 MB/s, so watch the credit dashboard in week one |
| Flat-price alternative | A dedicated Yellowstone gRPC node (Triton One, Chainstack and others; dedicated Solana nodes are listed from about $2,900/month) | Cheaper than metered streaming if volume makes credits expensive |
| Price data | A Jupiter API key (portal.jup.ag) | The free lite price API rate-limits at our volume (HTTP 429 seen); used to value trades in USDC, tokenized stocks and other quote assets |
| 24/7 host | A Linux server near your RPC provider's region (Frankfurt, Amsterdam or New York): 8+ cores, 32 GB RAM, 1 TB NVMe | This Mac has 12 GB of disk free and sleeps. On a server set `STORE_TRADES=all` and longer retention |

## Phase 2 — narrative engine and coin designer

| Need | What to get | `.env` key |
| --- | --- | --- |
| Claude API | API key from console.anthropic.com, with a monthly spend limit set | `ANTHROPIC_API_KEY` |
| X (Twitter) data | X developer account on pay-per-use (the default since February 2026). Reads are about $0.005 per post; filtered stream on pay-per-use is limited (reported 1 connection, 1,000 rules). Full firehose is Enterprise only. | `X_BEARER_TOKEN` |
| Image generation | One provider for coin art: OpenAI Images, Google Imagen, or Flux via fal.ai or Replicate. We pick one after testing quality | `IMAGE_API_KEY` |
| Market trending | DexScreener and Jupiter public APIs: free, no key | — |

## Phases 3–4 — launcher and live launches

| Need | What to get | Notes |
| --- | --- | --- |
| Launch wallet | A new Solana wallet used only for launches, made on your machine (for example `solana-keygen new -o ~/keys/launch.json`) | One consistent public creator wallet. The keypair file stays on your machine; `.env` only holds its path (`LAUNCH_KEYPAIR_PATH`). You fund it and you approve every launch |
| Transaction landing | Helius staked sending (included in paid plans) or Jito bundles | Gets create and sell transactions in fast |
| Approvals and alerts | Telegram bot from @BotFather (free) | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`. Approve or reject each launch from your phone |
| Coin socials (optional) | A real X account you own and run for a project | No bot or sockpuppet accounts. Posting through the API needs X write access |

## What stays with you

- Creating accounts, entering passwords and accepting provider terms.
- Holding the launch wallet's keys and approving every mainnet transaction.
- Setting spend limits on each paid API.
