# Roadmap

The bot reads the memecoin market, designs coins that traders actually want, launches them on pump.fun from one
public creator wallet, takes profit on the dev position in stages, keeps a moonbag, and gets better after every
batch of launches.

Ground rules: no fake volume, no hidden or bundled dev wallets, no sockpuppet promotion, no false claims in coin
metadata. Mainnet transactions are signed by the owner's wallet, never by the bot's developer tooling.

## Phase 1: Market observer and wallet intelligence (no SOL spent)

Status: built and running on the free public RPC (about 1.2 s median latency). Remaining Phase 1 work:

- gRPC source (Helius LaserStream or Yellowstone) with replay after disconnects, once a paid endpoint exists.
  On the public RPC a disconnect loses the events in the gap.
- Creator history backfill: reputation currently counts only launches seen since the observer started, while
  GMGN and Axiom show a creator's full history.
- A live dashboard for signals, top wallets and coins.
- Tune archetype thresholds once a few days of data exist.

- Live stream of every pump.fun bonding-curve and PumpSwap event: launches, trades, graduations, migrations.
- Per-coin live stats: unique buyers, volume, market cap, peak, time to peak, dev buys and sells, graduation,
  plus 1/5/15/60-minute checkpoints. These become the training data for Phase 2.
- Per-wallet live stats and trader archetypes: top performers, whales, aggressive traders, instant flippers,
  snipers, multi-coin traders, fixed-schedule traders. Updated on every trade, so the picture is seconds old.
- Creator reputation: how the market treats creators by launch history and dev-sell behaviour. This tells us
  how our own creator wallet will be judged and what exit pattern keeps buyers coming back.
- Coin metadata (description, image, socials) fetched for coins that get traction, plus a baseline sample.

Latency targets: event to updated wallet state in about 1–3 s on a standard RPC websocket; well under 1 s on a
gRPC stream (Helius LaserStream or a Yellowstone node).

## Phase 2: Narrative engine and coin designer (shadow mode, no SOL spent)

- Narrative engine runs continuously: X (tracked accounts plus keyword rules), pump.fun and PumpSwap trending,
  DexScreener trending, news. Narratives are clustered, scored for momentum, and decay when they go quiet, so the
  current picture is always minutes old, not hours.
- Coin designer: Claude proposes name, ticker, description and art direction for the strongest live narratives;
  an image model makes the art. Each concept is scored against Phase 1 data for similar coins.
- Shadow mode: the designer produces a concept every hour without launching. We measure whether coins like its
  picks did well in the following hours, against a random-launch baseline.
- Gate to Phase 4: shadow picks beat the baseline over a meaningful sample.

## Phase 3: Launcher and exit manager (paper)

- Build create, buy and sell transactions with the official `@pump-fun/pump-sdk`; simulate against mainnet state.
- Exit policy engine: staged take-profit, moonbag, time stop, no-buyer exit, plus rules shaped by the creator
  reputation findings (for example, selling slower so the wallet's history stays attractive).
- Track creator fees (now kept on the curve and swept) as a second revenue line.
- Paper-trade the exit policies against real live curves.

## Phase 4: Live launches, small and gated

- One consistent public creator wallet. The owner approves every launch (Telegram approval button).
- Hard limits on SOL per launch and per day, and a kill switch.

## Phase 5: Batch post-mortems and the playbook loop

- The unit of learning is a batch of recent launches, not one coin. Each batch post-mortem compares our launches
  against each other, against the market baseline from Phase 1, and against the shadow picks.
- Each post-mortem records what went right, what went wrong and what went sideways, with the evidence, then
  proposes specific playbook changes framed as hypotheses to test in the next batch.
- The playbook is versioned; every launch records the playbook version it used, so results can be attributed.
- The owner approves playbook changes before they go live.
- Once the loop is trusted: auto-launch within the owner's limits.
