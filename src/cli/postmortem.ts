import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config.ts';
import { PLAYBOOK, matchesPlaybook } from '../playbook.ts';
import { postMortem, type Expectation, type LaunchOutcome } from '../postmortem.ts';
import { awayFromGaps, feedGaps, loadBacktestCoins, runPolicy, type BacktestCoin } from '../sim/backtest.ts';
import { RECORDED_DEV, policyGrid } from '../sim/policies.ts';
import { DEFAULT_SIM } from '../sim/simulate.ts';
import { launchTraits, POST_AGE_MAX_SEC } from '../sim/traits.ts';

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

if (args.includes('--help')) {
  console.log(`usage: npm run postmortem -- [--batch 10] [--mode paper|live] | --shadow 10

Reviews the last batch of the bot's launches (the our_launches table): what it made against what the playbook
expected from other devs' launches in the 24 hours before, the gap split into picking (hit rate), coins (flow once
busy) and execution (actual minus the plan replayed on the same coins), the exit checked in hindsight, and at most
three actions. --shadow N runs it on the last N recorded single-wallet launches that match the playbook, with the
recorded dev's trades as "what we did", to see the review before the bot has launched.`);
  process.exit(0);
}
if (!existsSync(config.dbPath)) {
  console.error(`No database at ${config.dbPath}. Run "npm run observe" first.`);
  process.exit(1);
}

const db = new DatabaseSync(config.dbPath, { readOnly: true });
db.exec('PRAGMA busy_timeout = 5000;');
const o = { ...DEFAULT_SIM, horizonSec: 600 };
const nowTs = Math.floor(Date.now() / 1000);
const shadow = opt('shadow');
const size = Number(shadow ?? opt('batch') ?? 10);

const coins = loadBacktestCoins(db, 0, nowTs - o.horizonSec).sort((a, b) => a.createdTs - b.createdTs);
const gaps = coins.length ? feedGaps(db, coins[0]!.createdTs, nowTs) : [];
const clear = awayFromGaps(coins, gaps, o.horizonSec);
const traits = launchTraits(db, clear, (clear[0]?.createdTs ?? nowTs) - 86400);
const matching = clear.filter((c) => c.clean && matchesPlaybook(PLAYBOOK, traits.get(c.mint)!));
const byMint = new Map(coins.map((c) => [c.mint, c]));

/**
 * The batch. `coin` is the launch as the observer recorded it, for the replays; null when the observer has no usable
 * record of it (a feed gap, too little time since), in which case the launch counts with its actual result and no
 * replay comparison.
 */
let batch: { mint: string; ts: number; symbol: string | null; coin: BacktestCoin | null; pnl: number; drew: boolean; postAgeSec: number | null; firstOnPost: boolean | null }[];
if (shadow) {
  batch = matching.slice(-size).map((coin) => ({
    mint: coin.mint,
    ts: coin.createdTs,
    symbol: coin.symbol,
    coin,
    pnl: runPolicy([coin], RECORDED_DEV, o)[0]!,
    drew: coin.active,
    postAgeSec: POST_AGE_MAX_SEC[traits.get(coin.mint)!.postAge as keyof typeof POST_AGE_MAX_SEC] ?? null,
    firstOnPost: traits.get(coin.mint)!.postOrder === 'first',
  }));
} else {
  const rows = db
    .prepare(`SELECT mint, created_ts, pnl_sol, drew, post_age_sec, first_on_post FROM our_launches
              WHERE mode = ? AND pnl_sol IS NOT NULL ORDER BY created_ts DESC LIMIT ?`)
    .all(opt('mode') ?? 'paper', size) as { mint: string; created_ts: number; pnl_sol: number; drew: number; post_age_sec: number | null; first_on_post: number | null }[];
  batch = rows.reverse().map((r) => ({
    mint: r.mint,
    ts: r.created_ts,
    symbol: byMint.get(r.mint)?.symbol ?? r.mint.slice(0, 6),
    coin: byMint.get(r.mint) ?? null,
    pnl: r.pnl_sol,
    drew: Boolean(r.drew),
    postAgeSec: r.post_age_sec,
    firstOnPost: r.first_on_post === null ? null : Boolean(r.first_on_post),
  }));
}
if (!batch.length) {
  console.error(shadow ? 'No recorded launches match the playbook.' : 'No launches of ours with results yet; try --shadow 10.');
  process.exit(1);
}

// Expectation: other devs' launches under the same rules in the 24 hours before the batch.
const from = batch[0]!.ts;
const inBatch = new Set(batch.map((b) => b.mint));
// With fewer than 5 such launches (a short recording, strict rules) every matching launch outside the batch is used.
const prior = matching.filter((c) => c.createdTs < from && c.createdTs >= from - 86400 && !inBatch.has(c.mint));
const before = prior.length >= 5 ? prior : matching.filter((c) => !inBatch.has(c.mint));
const expectationFrom = prior.length >= 5 ? 'in the 24 h before' : 'outside the batch (too few in the 24 h before)';
const beforePnl = runPolicy(before, PLAYBOOK.exit, o);
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const exp: Expectation = {
  launches: before.length,
  hitRate: mean(before.map((c) => (c.active ? 1 : 0))),
  meanBusy: mean(beforePnl.filter((_, i) => before[i]!.active)),
  meanDead: mean(beforePnl.filter((_, i) => !before[i]!.active)),
};

// A launch the observer has no record of replays as its own result under every plan: no gap, no hindsight edge.
const replay = (policy: Parameters<typeof runPolicy>[1]) => batch.map((b) => (b.coin ? runPolicy([b.coin], policy, o)[0]! : b.pnl));
const plan = replay(PLAYBOOK.exit);
const outcomes: LaunchOutcome[] = batch.map((b, i) => ({
  mint: b.mint,
  symbol: b.symbol,
  pnl: b.pnl,
  drew: b.drew,
  planPnl: plan[i]!,
  postAgeSec: b.postAgeSec,
  firstOnPost: b.firstOnPost,
}));
const hindsight = new Map(policyGrid().map((p) => [p.name, replay(p)] as const));
const pm = postMortem(outcomes, exp, hindsight, PLAYBOOK.pauseAfterDeadInARow);
const unreplayed = batch.filter((b) => !b.coin).length;

const f = (x: number) => `${x >= 0 ? '+' : ''}${x.toFixed(2)}`;
const pct = (x: number) => `${Math.round(x * 100)}%`;
const when = (ts: number) => new Date(ts * 1000).toISOString().slice(5, 16).replace('T', ' ');
console.log(
  `\n== Post-mortem, playbook v${PLAYBOOK.version}${shadow ? ' (shadow: recorded devs as "us")' : ''}: ${pm.launches} launches, ` +
    `${when(from)}-${when(batch.at(-1)!.ts)} UTC ==\n`,
);
if (unreplayed) console.log(`  (${unreplayed} launch(es) not in the observer's record: counted at their actual result, without a replay)`);
console.log(`  Made          ${f(pm.total)} SOL (${f(pm.mean)} a launch); expected ${f(pm.expectedMean)} a launch from ${exp.launches} ` +
  `matching launches by other devs ${expectationFrom}`);
console.log(`  Drew buyers   ${pct(pm.hitRate)} (90% ${pct(pm.hitRateLo)}-${pct(pm.hitRateHi)}); expected ${pct(exp.hitRate)}`);
console.log(`  Gap a launch  picking ${f(pm.gap.picking)}, coins ${f(pm.gap.coins)}, execution ${f(pm.gap.execution)} SOL`);
console.log(`  Exit          ${pm.exitHindsight ? `"${pm.exitHindsight.plan}" beat it in hindsight beyond noise` : 'no plan beat the playbook exit beyond noise in hindsight'}`);
console.log('\n  Launches:');
for (const l of outcomes) {
  console.log(`    ${(l.symbol ?? '?').slice(0, 12).padEnd(12)} ${l.drew ? 'busy' : 'dead'}  made ${f(l.pnl).padStart(6)}  plan ${f(l.planPnl).padStart(6)}`);
}
console.log('\n  Actions:');
pm.actions.forEach((a, i) => console.log(`    ${i + 1}. ${a}`));
