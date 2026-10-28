import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

/**
 * The daily check of the playbook against the newest data, in one command: refreshes the launch export and the X
 * watchlist, then re-runs the checks a playbook change would rest on (docs/PLAYBOOK.md, "How the playbook improves")
 * and saves everything to data/reports/daily-<date>.txt. Read-only: nothing here trades or sends.
 */

if (process.argv.includes('--help')) {
  console.log('usage: npm run daily\n\nRe-runs the playbook checks on the newest data and saves the report to data/reports/.');
  process.exit(0);
}

const node = ['--disable-warning=ExperimentalWarning'];
const steps: { title: string; cmd: string; args: string[]; tail?: number }[] = [
  { title: 'Launch export', cmd: 'node', args: [...node, 'src/cli/exportLaunches.ts'] },
  { title: 'X watchlist', cmd: 'python3', args: ['ml/watchlist.py', '40'], tail: 8 },
  { title: 'Dev buy: sniper step and sizes', cmd: 'python3', args: ['ml/devbuy.py'] },
  { title: 'Exit on held-out blocks (5 SOL launches)', cmd: 'node', args: [...node, 'src/cli/simulate.ts', '--folds', '4', '--horizon', '10', '--min-dev-buy', '4.9', '--cohort', 'normal'], tail: 22 },
  { title: 'Launch rules by period', cmd: 'python3', args: ['ml/rulecheck.py'] },
  { title: 'Sealed hours', cmd: 'python3', args: ['ml/sealed.py'] },
  { title: 'Timing', cmd: 'python3', args: ['ml/timing.py'], tail: 30 },
  { title: 'Our launches', cmd: 'node', args: [...node, 'src/cli/postmortem.ts', '--mode', 'live'], tail: 25 },
];

const date = new Date().toISOString().slice(0, 10);
let report = `Daily playbook check, ${new Date().toISOString()}\n`;
for (const s of steps) {
  process.stdout.write(`${s.title}... `);
  const r = spawnSync(s.cmd, s.args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
    .split('\n')
    .filter((l) => !/Warning|warnings\.warn|DeprecationWarning/.test(l))
    .join('\n')
    .trim();
  const shown = s.tail ? out.split('\n').slice(-s.tail).join('\n') : out;
  report += `\n== ${s.title} ${r.status === 0 ? '' : `(exit ${r.status})`}==\n${shown}\n`;
  console.log(r.status === 0 ? 'done' : `exit ${r.status}`);
}
mkdirSync('data/reports', { recursive: true });
const path = `data/reports/daily-${date}.txt`;
writeFileSync(path, report);
console.log(`\nSaved ${path}`);
