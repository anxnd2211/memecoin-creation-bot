import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config.ts';
import { ARCHETYPES } from '../intel/classify.ts';
import {
  boughtOutCoins,
  creatorResponse,
  devExitOutcomes,
  marketSummary,
  nameLift,
  observerStatus,
  topCoins,
  walletsByArchetype,
} from '../intel/reports.ts';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string, fallback: number) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};

if (flag('help')) {
  console.log(`usage: npm run report -- [--hours 24] [--limit 10] [--json]

Sections: observer health, market summary, top coins, wallets by archetype,
creator reputation vs. buyer response, dev exit timing vs. outcome, name words with traction.`);
  process.exit(0);
}

if (!existsSync(config.dbPath)) {
  console.error(`No database at ${config.dbPath}. Run "npm run observe" first.`);
  process.exit(1);
}

const db = new DatabaseSync(config.dbPath, { readOnly: true });
db.exec('PRAGMA busy_timeout = 5000;');
const nowTs = Math.floor(Date.now() / 1000);
const hours = opt('hours', 24);
const limit = opt('limit', 10);
const sinceTs = nowTs - hours * 3600;

const status = observerStatus(db);
const solUsd: number = status?.solUsd ?? 0;
const data = {
  generatedAt: new Date().toISOString(),
  windowHours: hours,
  solUsd,
  observer: status,
  market: marketSummary(db, sinceTs),
  topCoins: topCoins(db, sinceTs, limit),
  boughtOut: boughtOutCoins(db, sinceTs, limit),
  wallets: walletsByArchetype(db, sinceTs, nowTs, limit),
  creatorResponse: creatorResponse(db, sinceTs),
  devExitOutcomes: devExitOutcomes(db, sinceTs, nowTs),
  nameLift: nameLift(db, sinceTs),
};

if (flag('json')) {
  console.log(JSON.stringify(data, null, 2));
  process.exit(0);
}

// ---- Plain-text rendering ----

const short = (a: string | null | undefined) => (a ? `${a.slice(0, 4)}…${a.slice(-4)}` : '-');
const pct = (x: number | null | undefined) => (x === null || x === undefined ? '-' : `${Math.round(x * 100)}%`);
const num = (x: number | null | undefined, d = 1) => (x === null || x === undefined ? '-' : x.toFixed(d));
const usd = (sol: number | null | undefined) => {
  if (sol === null || sol === undefined || !solUsd) return '-';
  const v = sol * solUsd;
  return v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(1)}k` : `$${v.toFixed(0)}`;
};
const dur = (s: number | null | undefined) => {
  if (s === null || s === undefined) return '-';
  if (!Number.isFinite(s)) return '>1d';
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${(s / 3600).toFixed(1)}h`;
};

function table(rows: Record<string, string | number>[]): void {
  if (!rows.length) {
    console.log('  (no data yet)');
    return;
  }
  const cols = Object.keys(rows[0]!);
  const widths = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c]).length)));
  const line = (vals: string[]) => '  ' + vals.map((v, i) => v.padEnd(widths[i]!)).join('  ');
  console.log(line(cols));
  console.log(line(widths.map((w) => '-'.repeat(w))));
  for (const r of rows) console.log(line(cols.map((c) => String(r[c]))));
}

function heading(title: string): void {
  console.log(`\n== ${title} ==`);
}

heading(`Observer (window: last ${hours}h)`);
if (status) {
  console.log(
    `  last status ${status.at} | connected ${status.connected} | lag p50 ${status.lagP50}s p95 ${status.lagP95}s | ` +
      `${status.curveTradesPerSec} curve + ${status.ammTradesPerSec} PumpSwap trades/s | ${status.launchesPerMin} launches/min`,
  );
  console.log(
    `  reconnects ${status.reconnects}, seconds lost to gaps ${status.gapSeconds}, duplicate events dropped ` +
      `${status.duplicateEvents ?? 0}${status.confirm ? `, unconfirmed txs dropped ${status.confirm.phantom}` : ''}, ` +
      `SOL $${num(solUsd, 2)}`,
  );
} else console.log('  no status yet');

heading('Market');
const m = data.market;
console.log(
  `  launches ${m.launches} | graduated through trading ${m.graduatedThroughTrading} (median ${dur(m.medianSecondsToGraduate)}) | ` +
    `bought out at launch ${m.boughtOutAtLaunch}`,
);
console.log(
  `  traction (25+ organic buyers in 5m) ${pct(m.tractionShare)} | median organic buyers at 5m ${num(m.medianOrganicBuyers5m, 0)}`,
);
console.log(
  `  bundled/sniped at launch (5+ buyers in first 3s) ${pct(m.bundledShare)} | dev bought at launch ${pct(m.devBoughtShare)} | ` +
    `of those, dev sold within 60s ${pct(m.devSoldWithin60sShare)}`,
);

heading('Top coins by peak market cap (launch buyouts excluded)');
table(
  data.topCoins.map((c) => ({
    coin: `${c.symbol ?? '?'} ${short(c.mint)}`,
    peak: usd(c.peakMcapSol),
    'to peak': dur(c.secondsToPeak),
    now: usd(c.lastMcapSol),
    buyers: c.buyers,
    early: c.earlyBuyers,
    'organic 5m': c.organic5m ?? '-',
    smart: c.smartBuys,
    'dev 1st sell': dur(c.devFirstSellSec),
    grad: c.graduated ? 'yes' : '',
  })),
);

heading('Bought out at launch (whole curve bought in the launch second)');
table(
  data.boughtOut.map((c) => ({
    coin: `${c.symbol ?? '?'} ${short(c.mint)}`,
    creator: short(c.creator),
    peak: usd(c.peakMcapSol),
    now: usd(c.lastMcapSol),
    'buyers after launch': c.buyersAfterLaunch,
    'volume SOL': num(c.volumeSol, 0),
  })),
);

for (const [archetype, rows] of Object.entries(data.wallets)) {
  heading(`Wallets: ${archetype} (${ARCHETYPES[archetype]})`);
  table(
    rows.map((w) => ({
      wallet: short(w.wallet),
      'realized SOL': num(w.realizedSol),
      'win %': pct(w.winRate),
      closed: w.closed,
      'trades/day': num(w.tradesPerDay, 0),
      'avg buy': num(w.avgBuySol, 2),
      '5+ SOL buys': w.largeBuys,
      'median hold': dur(w.medianHoldSec),
      'snipe %': pct(w.snipeShare),
      'max open': w.maxOpen,
      also: w.archetypes.filter((a) => a !== archetype).join(','),
    })),
  );
}

heading('Creator history vs. buyer response');
console.log('  History only counts launches the observer has seen, so it understates long-running creators.');
table(
  data.creatorResponse.map((r) => ({
    'creator history': r.bucket,
    coins: r.coins,
    'median organic 5m': num(r.medianOrganic5m, 0),
    traction: pct(r.tractionShare),
    graduated: pct(r.graduatedShare),
    'median peak': usd(r.medianPeakMcapSol),
  })),
);

heading('Dev first sell vs. outcome (coins over 1h old, dev bought at launch)');
console.log('  Correlation, not cause: strong coins also give devs more reason to hold.');
table(
  data.devExitOutcomes.map((r) => ({
    'dev first sold': r.bucket,
    coins: r.coins,
    'organic 5m': num(r.medianOrganic5m, 0),
    'organic 60m': num(r.medianOrganic60m, 0),
    graduated: pct(r.graduatedShare),
    'median peak': usd(r.medianPeakMcapSol),
    'mean peak': usd(r.meanPeakMcapSol),
  })),
);

heading('Name/ticker words over-represented among coins with traction');
table(
  data.nameLift.map((r) => ({ word: r.word, launches: r.launches, 'with traction': r.withTraction, lift: num(r.lift) })),
);
console.log();
