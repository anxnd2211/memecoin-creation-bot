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
  and sells, graduation, and snapshots at 1, 5, 15 and 60 minutes.
- **Wallets:** realized PnL (average cost, fees included), win rate, hold-time distribution, trades per day, buy
  sizes, snipe rate, coins opened per hour, busiest hours, launches. Archetypes: top performer, whale, aggressive,
  flipper, sniper, multi-coin, scheduled, bot-like, serial creator (thresholds in `src/intel/classify.ts`).
- **Signals** (printed live and stored): traction (25+ organic buyers within 5 minutes), smart-money entry (a top
  performer or whale buying a coin under 30 minutes old), graduation, dev sold everything.
- **Prices:** every trade is valued in SOL, including coins paired with USDC, tokenized stocks, wrapped BTC or
  other pump coins (Jupiter prices, with each quote mint's real decimals).

Run `npm run update-idl` when pump.fun announces a program upgrade.

## Layout

```
src/chain      decoder, live stream, confirmation gate, PumpSwap pool resolver
src/intel      engine, positions, archetypes, report queries
src/market     SOL and quote prices, coin metadata fetcher
src/store      SQLite schema and writes
src/cli        observe, report, inspect, update-idl
idl/           pump.fun program IDLs (from github.com/pump-fun/pump-public-docs)
test/          unit tests and real mainnet transaction fixtures
```
