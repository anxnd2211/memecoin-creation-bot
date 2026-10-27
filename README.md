# Memecoin Creation Bot

A pump.fun bot that reads the market, designs coins traders want, launches them from one public creator wallet,
takes profit in stages, and improves after every batch of launches. See [docs/ROADMAP.md](docs/ROADMAP.md) for the
phases and [docs/ACCOUNTS.md](docs/ACCOUNTS.md) for the subscriptions each phase needs.

**Current state: Phase 1, the market observer and wallet intelligence.** It spends no SOL and needs no keys.

## Quick start

Requires Node 24+.

```bash
npm install
npm run observe          # stream pump.fun live into data/observer.db (Ctrl+C to stop)
npm run report           # market, top coins, wallets by archetype, creator and dev-exit analysis
npm run report -- --hours 6 --limit 20
npm run report -- --json # same data as JSON, for the Phase 5 post-mortems
npm run inspect -- <wallet or mint>
npm run devs             # dev screen: what each dev spent, took out and earned in fees, and how they sold
npm run devs -- --clean --hours 2   # only coins whose launcher and fees were recorded live
npm run devs -- --since 2026-10-27T05:25Z --until 2026-10-27T07:45Z --clean   # a fixed window
npm run wallet-history -- <wallet>  # on-chain age, transaction count and first funder of a wallet
npm run simulate         # exit backtest: our dev position replayed under 1,800 selling plans
npm run simulate -- --folds 3       # each time block held out in turn
npm run traits           # which launch traits (dev buy, links, tool, ticker wave, dev history) draw buyers
npm run backfill-metadata -- --since 2026-10-27T04:22Z   # fetch metadata the observer skipped
npm run export-launches  # one line per launch for the models in ml/ (docs/MODELS.md)
python3 ml/devbuy.py     # the dev buy that pays best, and where sniper bots start
python3 ml/sells.py 6    # how the devs who made money in the last 6 h sold, against our exit
python3 ml/launchers.py  # launcher league, the X accounts behind winning coins, and post-to-launch speed
python3 ml/model.py      # launch-decision model, scored on launches it never saw
npm run export-paths     # each launch's price path with our bag, for exit research
python3 ml/exits.py      # the exit ceiling, and smarter exits against v2 on held-out blocks
python3 ml/opportunities.py   # first-on-post results by speed, source-account tiers, chances an hour
python3 ml/sealed.py     # final check on launches sealed away from all research
python3 ml/timing.py     # clock hours and the market's state before a launch, and timing policies simulated
npm run postmortem -- --shadow 10   # the batch review (on our launches once they exist)
npm test
```

Copy `.env.example` to `.env` to switch to a paid RPC or change storage settings.

## How Phase 1 works

```
Solana RPC websocket (logsSubscribe on the pump.fun and PumpSwap programs)
  → decoder: Anchor events from pump.fun's official IDLs (launches, trades, graduations, migrations, pools)
  → duplicate filter: drops re-delivered events (optional status check with VERIFY_TXS on a paid RPC)
  → pool resolver: maps PumpSwap pools to coins (events, then RPC account reads)
  → engine: live coin, wallet and position state, trader archetypes, signals
  → SQLite (WAL), flushed every 2 s; idle state evicted and reloaded on demand
```

- **Coins:** buyers, launch-second buyers (snipers and bundles), organic buyers, volume, market cap, peak, dev buys
  and sells, creator fees, graduation, Mayhem mode, and snapshots at 1, 5, 15 and 60 minutes. The dev is the
  creator plus the wallet that signed the launch, which differs on about a fifth of launches.
- **Trades:** each stored trade records the program it went through when not called directly (trading terminals,
  routers, pump.fun's Mayhem agent).
- **Wallets:** realized PnL (average cost, fees included), win rate, hold-time distribution, trades per day, buy
  sizes, snipe rate, coins opened per hour, busiest hours, launches. Archetypes: top performer, whale, aggressive,
  flipper, sniper, multi-coin, scheduled, bot-like, serial creator (thresholds in `src/intel/classify.ts`).
- **Signals** (printed live and stored): traction (25+ organic buyers within 5 minutes), smart-money entry (a top
  performer or whale buying a coin under 30 minutes old), graduation, dev sold everything.
- **Prices:** every trade is valued in SOL, including coins paired with USDC, tokenized stocks, wrapped BTC or
  other pump coins (Jupiter prices, with each quote mint's real decimals).

Run `npm run update-idl` when pump.fun announces a program upgrade.

## Paper launches on a local copy of pump.fun

`npm run paper-fork` runs a launch on a local fork of pump.fun: [LiteSVM](https://github.com/LiteSVM/litesvm) loaded
with pump.fun's real program binaries (bonding curve, fee program, Mayhem program, Token-2022, SPL Token, Associated
Token) and the accounts they read (Global, fee config, volume accumulator, fee recipients, rent). These are fetched
read-only from mainnet once and cached in `data/fork/`. Every signer is an in-memory keypair that exists only on the
fork; nothing is ever sent to mainnet.

```bash
npm run paper-fork -- --dev-buy 5 --sell-all                    # launch with a 5 SOL dev buy, then sell the whole bag
npm run paper-fork -- --dev-buy 5 --outside 2,1.5,3 --sell-all  # three fresh wallets buy before the dev sells
npm run paper-fork -- --dev-buy 3 --priority 125000 --json      # with a priority fee (micro-lamports per CU), as JSON
npm run paper-fork -- --replay <signature>                       # re-run a landed mainnet transaction, compare exactly
npm run paper-fork -- --refresh --dev-buy 3 --sell-all          # re-fetch the snapshot first (after a pump.fun upgrade)
```

The launch is what pump.fun's site sends today: `create_v2` (a Token-2022 coin, normal mode), the dev's token account
and `buy_v2`, in one transaction through an address lookup table; other wallets buy with `buy_v2` and sell with
`sell_v2`. The output lists SOL into and out of the curve, protocol and creator fees, tokens, rent per account,
network fees and compute units per instruction, next to `src/chain/curve.ts` and the difference. `--replay` checks the
fork itself: a recorded 2 SOL mainnet launch replays with the same balance changes and compute units (221,882), and
`npm test` repeats that check. `src/paper/fork.ts` (`launch`, `buy`, `sell`, any number of local wallets) is what the
paper-mode loop will run on.

## Layout

```
src/chain      decoder, live stream, confirmation gate, PumpSwap pool resolver, bonding-curve math
src/intel      engine, positions, archetypes, report queries, dev screen
src/market     SOL and quote prices, coin metadata fetcher
src/sim        trade-order rebuild, launch replay, selling plans, backtest scoring
src/paper      local pump.fun fork (LiteSVM + mainnet binaries), snapshot cache, mainnet replay check
src/store      SQLite schema and writes
src/cli        observe, report, inspect, devs, simulate, traits, export-launches, export-paths, postmortem, paper-fork, wallet-history, backfills, update-idl
src/playbook.ts  the versioned launch playbook (docs/PLAYBOOK.md)
src/postmortem.ts  the batch review: gap split into picking, coins and execution
ml/            Python models and market reports over the launch export (docs/MODELS.md)
idl/           pump.fun program IDLs (from github.com/pump-fun/pump-public-docs)
test/          unit tests and real mainnet transaction fixtures
```
