# Roadmap

The bot reads the memecoin market, designs coins that traders actually want, launches them on pump.fun from one
public creator wallet, takes profit on the dev position in stages, keeps a moonbag, and gets better after every
batch of launches.

Ground rules: no fake volume, no hidden or bundled dev wallets, no rotating creator addresses to hide history, no
sockpuppet promotion, no false claims or impersonation in coin metadata. Mainnet transactions are signed by the
owner's wallet, never by the bot's developer tooling.

## What the market data says about making money as a dev

From the dev screen (`npm run devs`, [DEV-SCREENING.md](DEV-SCREENING.md)) and the exit backtest
(`npm run simulate`, [EXIT-BACKTEST.md](EXIT-BACKTEST.md)); about four hours of clean data on 2026-10-27, with the
screen's findings checked on hours they were not built from. Strong leads, not settled facts:

- **On a normal curve a dev who buys in the create transaction can lose at most the fees** when selling the whole
  bag: about 1.9% of the dev buy plus about 0.02 SOL of rent and network fees. No one can sell back more tokens than
  they bought after the dev, so the price never falls below the dev's entry. Mayhem mode breaks this.
- **The dev buy decides whether the sniper bots come.** Dev buys of 3–4.5 SOL (about 10–14% of supply) drew a median
  7 SOL of outside buying in the first three seconds; dev buys just under 3 SOL drew a fraction of that, and dev buys
  under 1 SOL drew nothing. Single-wallet launches buying 3–4.5 SOL made +1.4 SOL per launch on average, 84% of them
  profitable, across 24 devs.
- **Hold the dev bag about 20 seconds, then sell everything.** In replays held out from the choice, that beat selling
  into the first buyers by about 0.1–0.2 SOL per launch and edged what the recorded devs did; in the newest half hour
  the recorded devs, who sold in steps over two minutes, did better, so the exit is re-fitted daily.

- **The dev's profit comes out of other wallets' net inflow before the dev sells.** Under 0.5 SOL of net inflow
  before the first dev sell, 39% of devs made money; 0.5–2 SOL, 91%; above 2 SOL, all of them. The exit manager is
  keyed to inflow, not to the clock.
- **The money arrives in the first ten seconds.** By 30 seconds after launch, selling matches buying.
- **A dev's first sell does not end a coin with real demand.** 56% of busy coins peaked after the dev's first sell,
  so a moonbag is worth keeping.
- **Most dev profit (83% on busy coins) went to devs using extra wallets** around the launch, or a separate signer
  and creator that keeps their history off GMGN and Axiom. Single-wallet devs, the way we launch, made money on 64%
  of busy coins and on 38 of 43 normal (non-Mayhem) busy coins, but mostly tenths of a SOL to a few SOL per coin.
- **Creator fees are a main revenue line,** 35% of all dev profit on busy coins (0.30% of every curve trade, paid
  whether or not the dev sells).
- **Edges decay within hours.** A dev farming pump.fun's Mayhem agent made 65 SOL overnight and lost 5 SOL the next
  hour. The playbook has to be re-checked against fresh data continually.
- **The first credible coin on a narrative takes the flow.** In one SBF wave, 44 coins launched in an hour; about
  five got traction and one took most of it.

## Engineering standard

Adapted from the methods in the owner's Olympus and Eris skills, which turn a noisy, adversarial, scored process
into a repeatable one.

1. **Gates fail closed, in a fixed order.** Every launch passes the same board (Phase 3). A gate that cannot be
   evaluated (data missing, feed lagging, price unknown) blocks the launch; it is never treated as a pass.
2. **Every decision leaves an auditable record.** Each launch gets a dossier with fixed fields (narrative and
   evidence, crowding count, name collisions, compliance check, dev buy, exit plan, playbook version, forecast,
   verdict). Post-mortems read dossiers, not memory.
3. **Validate the way the future will test you.** Playbook changes are tested on later, held-out launches and
   time windows, never on the launches they were tuned on (Eris: faithful folds, public vs private board). Keep
   one batch in three as a held-out batch.
4. **A small sample proves nothing.** One launch, or one good hour, is never evidence. A playbook change ships only
   when it beats the current version on a held-out batch by more than the noise between batches (Eris: paired
   gate, plateau stop after three misses).
5. **Every loss becomes a rule.** Each post-mortem ends with dated rules in `docs/PLAYBOOK-RULES.md` (created in
   Phase 5), each with its trigger, action and evidence, the way the Eris winner-lessons and Olympus changelog
   record theirs.
6. **Fit thresholds from data, inside the pipeline.** Archetype cut-offs, traction bars and exit triggers are
   re-estimated from the latest data on every run with a check on data they were not fitted on. Hand-typed
   numbers are starting points only (Eris rule U130).
7. **Preflight before every transaction.** Every create, buy and sell is simulated against current mainnet state
   first; a failed or surprising simulation blocks it (Eris: preflight before every submit).
8. **Check the result can be true.** Reports carry invariants: on a bonding curve all participants together can
   only lose SOL, so a positive combined result means missing data or overvalued holdings. The dev screen prints
   this check, and it caught two real bugs on day one.
9. **Watch for drift.** Daily checks that pump.fun's program IDLs, fee schedule and curve parameters still match
   what the code assumes (`npm run update-idl`), and an uptime target for the observer (95% or better), with
   alerts when it is missed.

## Phase 1: Market observer and wallet intelligence (no SOL spent)

Status: built and running on the free public RPC. Latency swings from about 1 s to 35 s and the websocket drops
several times an hour, so a paid stream is needed for seconds-level accuracy.

Built:

- Live stream of every pump.fun bonding-curve and PumpSwap event: launches, trades, graduations, migrations.
- Per-coin stats: buyers, launch-second buyers, organic buyers, volume, market cap, peak, dev buys and sells,
  graduation, creator fees, 1/5/15/60-minute checkpoints.
- The dev is the creator plus the wallet that signed the launch; about a fifth of launches name a different
  creator (fee recipient) from the signer.
- Per-wallet stats and archetypes, updated on every trade. Bags left on coins nobody trades for two hours are closed
  at their remaining value, so wallets that sell winners and abandon losers no longer look like winners. pump.fun's
  Mayhem agent is labelled as a protocol agent, never as smart money.
- Each stored trade records the program it went through (trading terminals, routers, the Mayhem agent).
- Reports: market (`report`), single coin or wallet (`inspect`), dev screen (`devs`), on-chain wallet age and
  funding (`wallet-history`). Naming waves are counted per dev, so one dev relaunching a name 100 times is not a
  narrative.

Remaining:

- Keep the observer recording around the clock: on 2026-10-27 it recorded nothing from 07:58 to 11:34 UTC while the
  Mac slept. A small always-on server, or the Mac kept awake and plugged in.
- gRPC source (Helius LaserStream or Yellowstone) with replay after disconnects.
- Full transactions per trade (the signer, token transfers), which the log stream does not carry: some pooled
  routers name one shared account for many traders, and tokens moved between wallets are invisible today.
- Ignore PumpSwap prices from dust trades, which can print absurd peaks after graduation.
- Store PumpSwap trades for coins that graduate, so post-graduation exits are measured.
- Creator history beyond the observed window (GMGN and Axiom show full history).
- A live dashboard; thresholds re-fitted from several days of data.

## Phase 2: Narrative engine and coin designer (shadow mode, no SOL spent)

- Narrative sources: X (tracked accounts plus keyword rules, through the official API), pump.fun and PumpSwap
  naming waves from our own feed, DexScreener trending, news. Narratives are clustered, scored for momentum and
  decay when they go quiet.
- Speed matters in seconds: the profitable launches in the screen sold into flow that arrived within 10 seconds
  of launch, so the path from a tweet to a launch-ready concept must be measured and kept short.
- Crowding gate: before designing, count how many launches already use the narrative's words in the last 10
  minutes and whether one already has traction. If a leader exists, do not launch a copy (Olympus: "how many
  others would independently build this exact thing?").
- Coin designer: Claude proposes name, ticker, description and art direction; an image model makes the art. Each
  concept is compared with the nearest past coins (name and narrative similarity) and how they did.
- Shadow mode: the designer produces concepts without launching. Each concept is scored later against what
  similar real launches did, versus a random-launch baseline. Gate to Phase 4: shadow picks beat the baseline on a
  held-out period.

## Phase 3: Launcher and exit manager (paper)

Status: the exit backtest is built (`npm run simulate`). It replays recorded launches with our position in place of
the dev's under about 1,300 selling plans, chooses plans on time blocks they are then not scored on, and reports
results against the recorded devs with paired noise intervals. Its first playbook, in
[EXIT-BACKTEST.md](EXIT-BACKTEST.md): normal mode, a 3 SOL dev buy, hold about 20 seconds, sell the whole bag.

- Build create, buy and sell transactions with the official `@pump-fun/pump-sdk`; simulate every one.
- Launch board, in order, each failing closed: narrative fresh; no crowding leader; no name or ticker collision
  with a live coin; compliance (no impersonation, no false claims, no implied endorsement); metadata complete;
  dev buy within limits; wallet balance and daily loss limit; simulation passes; owner approval.
- Exit manager: the plan chosen by the backtest, re-fitted daily with `npm run simulate -- --folds 3` and changed
  only when a new plan beats it on the pooled held-out blocks beyond the noise interval. The sell is pre-signed on
  a timer with a tight slippage limit, so it does not depend on reacting within a second. Candidates kept in the
  grid: tranches as net inflow crosses set levels, an exit when buying stops, and a moonbag kept only after the dev
  buy is recovered.
- Dev buy: the backtest's band (3 SOL now), re-checked daily, because it depends on how other traders' sniper bots
  are configured.
- Creator fees tracked as a separate revenue line and claimed on a schedule.
- Paper mode: the full loop runs against the live market without signing, recording what each policy would have
  done.

## Phase 4: Live launches, small and gated

- One public launch wallet, the same wallet as creator and signer, launching in normal mode (never Mayhem). The owner approves each launch from Telegram;
  the exit plan approved with it runs automatically, because tranche sells have to happen within seconds.
- Hard limits: SOL per launch, launches per day, daily loss, and a kill switch.
- First live batch: 10 launches. The SOL budget arithmetic is in [ACCOUNTS.md](ACCOUNTS.md).

## Phase 5: Batch post-mortems and the playbook loop

- The unit of learning is a batch of recent launches, never one coin.
- Each launch is scored 0–3 on narrative, execution and exit against a fixed rubric (adapted from the Olympus
  3/3/3 review), with the evidence for every deduction.
- Each batch is compared with the best coins launched in the same hours by other devs: what did the winners do
  that we did not? (Eris post-mortems read the winners' solutions the same way.)
- Proposed playbook changes are hypotheses, tested on the next held-out batch, and must not make earlier batches
  worse on replay. The playbook is versioned and every launch records the version it used.
- The owner approves playbook changes before they go live.
