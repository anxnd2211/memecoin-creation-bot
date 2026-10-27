import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config.ts';
import { PLAYBOOK, matchesPlaybook } from '../playbook.ts';
import { awayFromGaps, feedGaps, loadBacktestCoins, runPolicy, scoreResults, type BacktestCoin, type PolicyScore } from '../sim/backtest.ts';
import { DEFAULT_SIM } from '../sim/simulate.ts';
import { launchTraits, traitTable } from '../sim/traits.ts';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

if (flag('help')) {
  console.log(`usage: npm run traits -- [--since <date>] [--until <date>] [--horizon 10] [--json]

Compares what is known when a coin launches (launch tool, dev buy, X link, website, ticker wave, the dev's earlier
launches, hour) with whether single-wallet normal launches drew buyers, and what the current playbook's exit would
have made on them. Each trait is shown on the earlier and the later half of the launches separately, so a pattern
that does not hold up shows. Then scores the launches that match the playbook's launch rules against the rest.`);
  process.exit(0);
}

if (!existsSync(config.dbPath)) {
  console.error(`No database at ${config.dbPath}. Run "npm run observe" first.`);
  process.exit(1);
}

const db = new DatabaseSync(config.dbPath, { readOnly: true });
db.exec('PRAGMA busy_timeout = 5000;');
const nowTs = Math.floor(Date.now() / 1000);
const options = { ...DEFAULT_SIM, horizonSec: Number(opt('horizon') ?? 10) * 60 };
const date = (name: string): number | null => {
  const v = opt(name);
  if (v === undefined) return null;
  const ms = Date.parse(v);
  if (Number.isNaN(ms)) {
    console.error(`--${name} expects a date such as 2026-10-27T04:22Z, got ${v}`);
    process.exit(1);
  }
  return Math.floor(ms / 1000);
};
const liveSince = Number(
  (db.prepare("SELECT value FROM meta WHERE key = 'creator_fees_since'").get() as { value: string } | undefined)?.value ?? nowTs - 86400,
);
const since = date('since') ?? liveSince;
const until = Math.min(date('until') ?? Infinity, nowTs - options.horizonSec);
const gaps = feedGaps(db, since, until + options.horizonSec);
const coins: BacktestCoin[] = awayFromGaps(
  loadBacktestCoins(db, since, until).filter((c) => c.clean),
  gaps,
  options.horizonSec,
).sort((a, b) => a.createdTs - b.createdTs);
if (!coins.length) {
  console.error('No launches to compare in that window.');
  process.exit(1);
}
const pnls = runPolicy(coins, PLAYBOOK.exit, options);
// Earlier launches count for the dev's history and ticker waves.
const traits = launchTraits(db, coins, since - 86400);
const rows = traitTable(coins, pnls, traits);

const half = Math.floor(coins.length / 2);
const matchScore = (idx: number[]) =>
  scoreResults(
    idx.map((i) => coins[i]!),
    PLAYBOOK.exit,
    idx.map((i) => pnls[i]!),
  );
const all = coins.map((_, i) => i);
const matching = all.filter((i) => matchesPlaybook(PLAYBOOK, traits.get(coins[i]!.mint)!));
const rest = all.filter((i) => !matchesPlaybook(PLAYBOOK, traits.get(coins[i]!.mint)!));
const report = {
  playbook: PLAYBOOK.version,
  exit: PLAYBOOK.exit.name,
  from: coins[0]!.createdTs,
  to: coins.at(-1)!.createdTs,
  halfAt: coins[half]!.createdTs,
  launches: coins.length,
  traits: rows,
  playbookMatch: {
    all: matchScore(matching),
    firstHalf: matchScore(matching.filter((i) => i < half)),
    secondHalf: matchScore(matching.filter((i) => i >= half)),
    rest: matchScore(rest),
  },
};

if (flag('json')) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

const utc = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 16).replace('T', ' ');
const pct = (x: number | null | undefined) => (x === null || x === undefined ? '-' : `${Math.round(x * 100)}%`);
const num = (x: number | null | undefined, d = 3) => (x === null || x === undefined ? '-' : x.toFixed(d));
function table(rs: Record<string, string | number>[]): void {
  if (!rs.length) {
    console.log('  (no data)');
    return;
  }
  const cols = Object.keys(rs[0]!);
  const widths = cols.map((c) => Math.max(c.length, ...rs.map((r) => String(r[c]).length)));
  const line = (vals: string[]) => '  ' + vals.map((v, i) => v.padEnd(widths[i]!)).join('  ');
  console.log(line(cols));
  console.log(line(widths.map((w) => '-'.repeat(w))));
  for (const r of rs) console.log(line(cols.map((c) => String(r[c]))));
}
const heading = (t: string) => console.log(`\n== ${t} ==`);

heading(`Launch traits: ${coins.length} single-wallet normal launches, ${utc(report.from)} to ${utc(report.to)} UTC`);
console.log(`  Result = SOL per launch under playbook v${PLAYBOOK.version}'s exit (${PLAYBOOK.exit.name}), replayed ${options.horizonSec / 60} min.`);
console.log(`  Halves split at ${utc(report.halfAt)} UTC. Metadata is unknown where it could not be fetched.`);
for (const trait of [...new Set(rows.map((r) => r.trait))]) {
  heading(trait);
  table(
    rows
      .filter((r) => r.trait === trait)
      .map((r) => ({
        value: r.value,
        launches: r.launches,
        busy: pct(r.busyShare),
        'mean SOL': num(r.meanPnl),
        'first half: n / busy / mean': `${r.firstHalf.launches} / ${pct(r.firstHalf.busyShare)} / ${num(r.firstHalf.meanPnl)}`,
        'second half: n / busy / mean': `${r.secondHalf.launches} / ${pct(r.secondHalf.busyShare)} / ${num(r.secondHalf.meanPnl)}`,
      })),
  );
}

heading(`Launches matching playbook v${PLAYBOOK.version}'s launch rules (dev buy 2.95-4.5 SOL, tweet link, website) against the rest`);
const scoreRow = (label: string, s: PolicyScore) => ({
  launches: label,
  n: s.launches,
  'mean SOL': num(s.meanPnl),
  'median SOL': num(s.medianPnl),
  profitable: pct(s.profitableShare),
  'bad launch (p05)': num(s.p05),
  busy: pct(s.activeShare),
  'total w/o best 2': num(s.totalWithoutTop2, 1),
});
const m = report.playbookMatch;
table([
  scoreRow('matching, all', m.all),
  scoreRow('matching, first half', m.firstHalf),
  scoreRow('matching, second half', m.secondHalf),
  scoreRow('the rest', m.rest),
]);
console.log();
