import { DatabaseSync } from 'node:sqlite';
import { config } from '../config.ts';
import { awayFromGaps, feedGaps, loadBacktestCoins, pairedDifference, runPolicy, type BacktestCoin } from '../sim/backtest.ts';
import { copiedMints, createSlotReach, fakeDemand } from '../sim/demand.ts';
import { flowMoonPolicy, flowPolicy, splitPolicy, timePolicy } from '../sim/policies.ts';
import { DEFAULT_SIM, SLOT_SEC, type ExitPolicy } from '../sim/simulate.ts';
import { launchTraits, POST_AGE_MAX_SEC } from '../sim/traits.ts';

/**
 * Should we hold longer? The owner asked after the first live batch: the bot sells at 10-120 s, before traders have
 * time to come. This replays our 2 SOL bag on real-demand launches (copy launches and bundles left out) under the
 * playbook's exit and under longer holds, split sells and moonbags, with everyone else trading as recorded and the
 * dump that follows a dev sell moved to our sell.
 *
 * A replay cannot invent buyers who would have come had the recorded dev held, so a plan that holds past the recorded
 * dev's sell is judged on flow that the recorded dev's sell already shaped. The check is therefore repeated on launches
 * whose recorded dev held at least 2 minutes, where the flow up to then is the flow of a coin whose dev was still in.
 *
 * Usage: npm run hold-check
 */

const db = new DatabaseSync(config.dbPath, { readOnly: true });
db.exec('PRAGMA busy_timeout = 5000;');
const o = { ...DEFAULT_SIM, horizonSec: 600 };
const now = Math.floor(Date.now() / 1000);
const BAG = 2.025;

const coins = loadBacktestCoins(db, 0, now - o.horizonSec).sort((a, b) => a.createdTs - b.createdTs);
const gaps = feedGaps(db, coins[0]!.createdTs, now);
const clear = awayFromGaps(coins, gaps, o.horizonSec);
const traits = launchTraits(db, clear, clear[0]!.createdTs - 86400);
const reach = createSlotReach(coins);
const copied = copiedMints(db.prepare('SELECT mint, uri FROM coins').all().map((r) => [r.mint as string, r.uri as string | null]));

const fresh = (c: BacktestCoin) => {
  const t = traits.get(c.mint)!;
  return t.xLink === 'tweet' && t.postAge in POST_AGE_MAX_SEC && POST_AGE_MAX_SEC[t.postAge as keyof typeof POST_AGE_MAX_SEC] <= 120;
};
const cohort = clear.filter((c) => c.clean && !fakeDemand(c, reach, copied) && fresh(c) && traits.get(c.mint)!.postOrder === 'first');

/** Seconds from launch to the recorded dev's first sell; Infinity when the dev never sold in the replay window. */
function devFirstSell(c: BacktestCoin): number {
  const s0 = c.trades[0]!.slot;
  const t = c.trades.find((x) => x.dev && !x.isBuy);
  return t ? (t.slot - s0) * SLOT_SEC : Infinity;
}
const outsideBetween = (c: BacktestCoin, a: number, b: number) => {
  const s0 = c.trades[0]!.slot;
  return c.trades
    .filter((t) => !t.dev && (t.slot - s0) * SLOT_SEC > a && (t.slot - s0) * SLOT_SEC <= b)
    .reduce((s, t) => s + (t.isBuy ? t.sol : -t.sol), 0);
};

const bag = (p: ExitPolicy): ExitPolicy => ({ ...p, devBuySol: BAG });
const PLANS: ExitPolicy[] = [
  flowPolicy(10, 5, 0.5, 120, 0), // the playbook's exit (v3, v4)
  timePolicy(2, 0),
  timePolicy(3, 0),
  timePolicy(5, 0),
  flowPolicy(3, 3, 0.5, 120, 0),
  flowPolicy(5, 5, 0.5, 120, 0),
  flowPolicy(30, 5, 0.5, 300, 0),
  flowPolicy(60, 10, 0.5, 600, 0),
  flowPolicy(10, 15, 0.3, 600, 0),
  flowPolicy(10, 30, 0.2, 600, 0),
  timePolicy(30, 0),
  timePolicy(60, 0),
  timePolicy(120, 0),
  timePolicy(300, 0),
  timePolicy(600, 0),
  splitPolicy(10, 30, 4),
  splitPolicy(10, 60, 5),
  flowPolicy(10, 5, 0.5, 120, 0.25),
  flowMoonPolicy(10, 5, 0.25, 30, 600),
].map(bag);

const f = (x: number) => `${x >= 0 ? '+' : ''}${x.toFixed(2)}`;
const pct = (x: number) => `${Math.round(x * 100)}%`;

function report(title: string, set: BacktestCoin[]): void {
  console.log(`\n== ${title}: ${set.length} launches`);
  if (set.length < 10) return void console.log('   too few');
  const base = runPolicy(set, PLANS[0]!, o);
  const half = set[Math.floor(set.length / 2)]!.createdTs;
  for (const p of PLANS) {
    const r = runPolicy(set, p, o);
    const d = pairedDifference(r, base);
    const m = r.reduce((a, b) => a + b, 0) / r.length;
    const halves = [r.filter((_, i) => set[i]!.createdTs < half), r.filter((_, i) => set[i]!.createdTs >= half)];
    const hb = [base.filter((_, i) => set[i]!.createdTs < half), base.filter((_, i) => set[i]!.createdTs >= half)];
    const hd = halves.map((h, k) => h.reduce((a, b) => a + b, 0) / h.length - hb[k]!.reduce((a, b) => a + b, 0) / hb[k]!.length);
    console.log(
      `   ${p.name.padEnd(70)} ${f(m)}  profitable ${pct(r.filter((x) => x > 0).length / r.length).padStart(4)}` +
        (p === PLANS[0] ? '   (the playbook exit)' : `   vs playbook ${f(d!.mean)} (90% ${f(d!.lo)} to ${f(d!.hi)}); halves ${f(hd[0]!)} / ${f(hd[1]!)}`),
    );
  }
}

report('Real-demand first launches on posts under 2 min old, our 2 SOL bag', cohort);
report('The same, recorded dev held 2+ min (flow not yet shaped by a dev sell)', cohort.filter((c) => devFirstSell(c) >= 120));
report('Exactly 2 SOL dev buys only (our case)', cohort.filter((c) => Math.abs(c.launchBuySol - BAG) <= 0.03));
report('Exactly 2 SOL, sniped (others bought 1+ SOL in the create slot or the next)', cohort.filter((c) => Math.abs(c.launchBuySol - BAG) <= 0.03 && c.trades.filter((t) => !t.dev && t.isBuy && t.slot - c.trades[0]!.slot <= 1).reduce((a, t) => a + t.sol, 0) >= 1));

console.log('\n== Launches with no buying in their first 10 s: did buyers come later?');
const dead = cohort.filter((c) => outsideBetween(c, 0, 10) < 0.3);
for (const [name, set] of [
  ['recorded dev sold within 60 s', dead.filter((c) => devFirstSell(c) < 60)],
  ['recorded dev held 60 s+', dead.filter((c) => devFirstSell(c) >= 60)],
  ['recorded dev held 5 min+', dead.filter((c) => devFirstSell(c) >= 300)],
] as const) {
  const late = set.filter((c) => outsideBetween(c, 10, 600) >= 1);
  console.log(`   ${name.padEnd(32)} ${String(set.length).padStart(4)} launches; 1+ SOL of net buying later in 10 min: ${pct(late.length / Math.max(1, set.length))}`);
}
