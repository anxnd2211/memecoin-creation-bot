# Overnight build, 2026-10-27 23:49 to 2026-10-28 UTC

The goal for the night: make the bot ready for its first launches with real SOL. Start with
[LIVE-RUNBOOK.md](LIVE-RUNBOOK.md), "Start here".

## What is ready

- **`npm run live`**, in fork, dry and live modes, plus `--smoke` for one 0.1 SOL test launch from a test wallet. Each
  launch goes through these steps, in order:
  1. The launch board: 17 gates, each failing closed.
  2. The coin's metadata is pinned to IPFS on your Pinata account, while the transaction is simulated against
     mainnet.
  3. Your approval card on Telegram, with every gate and the source account's record.
  4. The board is checked again.
  5. The launch, from a mint address ending in "pump".
  6. The live exit, then sell rounds until the bag is gone.
  7. The result is recorded, measured as the wallet's real balance change.
- **Safety:**
  - `/kill` or `data/KILL` stops new launches.
  - A launch whose outcome is unknown pauses launching, then the bot finds and sells the bag.
  - A bag left by a crash is sold at the next start.
  - A failed sell pauses launching and keeps retrying with wider limits.
  - Hard limits: 10 launches a day, −1.5 SOL a day, at most 5.1 SOL per dev buy.
  - Dry and live modes are for you to run: the bot never signs anything during development, and Claude does not run
    those modes.
- **Your side:**
  - Telegram: `/launch <post url>` with a photo (the ticker and name are drafted from the post), or with the ticker
    and name yourself. Also `/status`, `/kill`, `/resume`, `/claim`.
  - An X watcher on 40 accounts ranked from our data, when an X API key is present.
- **Checks and upkeep:**
  - `npm run doctor` checks every key and service without printing secrets.
  - `npm run daily` re-runs the playbook checks on the newest data.
  - `npm run grind` makes mint addresses ending in "pump", like pump.fun's site.
  - `npm run shadow` runs the exit live on other devs' launches.

## What was verified

- **Fork runs** (pump.fun's real programs on a local copy, a recorded launch's traders replayed in real time):
  - Two single runs: +5.12 and +6.85 SOL, each sold on a stall at 13–16 s.
  - A batch of the 12 latest recorded 5 SOL launches (`npm run live -- --mode fork --batch 12`): +1.93 SOL a launch
    against +2.08 in the backtest on the same coins. Nine were within 0.03 SOL of the backtest, and the worst launch
    lost 0.10.
- **Live shadow, 88 launches** (the exit run on real launches as if we were their dev, public RPC, 1.25 s lag):
  - +4.80 SOL a launch, 86% profitable.
  - Inside our band, our exit beat what the devs did: 3 SOL +1.57 vs +1.12, 3.2–4.9 SOL +2.78 vs +1.96, 5 SOL a tie.
  - Launches matching the v3 rules: 100% profitable.
- **Sealed hours**, 22:35–00:45 UTC, never used in research:
  - The exit beat the recorded devs by +0.71 SOL a launch (90% +0.52 to +0.93).
  - 5 SOL beat 3 SOL.
  - v3-rule launches at 5 SOL made +5.00 (7 launches), all profitable.
- **Two independent code reviews** of the money path found 17 issues. All were fixed, with tests. 178 tests pass.

## Corrections made overnight

- **Slot time.** Mainnet slots are about 213 ms, not 400 ms. Re-measured with that, the flow exit still beats a timer
  up to about 4 s of delay. v3 now uses the flow exit up to 3 s of feed lag and a 15 s timer beyond (was 2 s and 20
  s).
- **Metadata hosting.** pump.fun's own metadata upload sits behind a Cloudflare bot check, and the bot does not work
  around it. Metadata goes to your Pinata account instead.
- **IPFS gateways.** ipfs.io, dweb.link and Pinata's gateway rate-limit this machine (HTTP 429) because the observer
  fetches every launch's metadata. That blocked first-on-post checks, and it would have blocked every upload check.
  Both now ask every gateway at once, and the observer puts the working ones first.
- **Fees.** Successful 5 SOL devs land launches with about a 0.005 SOL Jito tip and almost no priority fee. Our Sender
  tip defaults to 0.001 SOL.

## What you need to do

The accounts and keys in [LIVE-RUNBOOK.md](LIVE-RUNBOOK.md): Helius, Telegram, Pinata, a launch wallet with about
8 SOL, and optionally the X API. Then run `npm run doctor` until it shows no FAIL, and follow the start-here steps.
