import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config.ts';
import { archetypesById, devScreenReport, screenLaunches, type DevCoin } from '../intel/devs.ts';
import { observerStatus } from '../intel/reports.ts';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string, fallback: number) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};

if (flag('help')) {
  console.log(`usage: npm run devs -- [--hours 24] [--min-age 15] [--limit 12] [--clean] [--json]

Screens launches from the last --hours that are at least --min-age minutes old: what each creator spent, took
out and earned in creator fees, when and into what they sold, and how the rest of the market traded those coins.
--clean keeps only coins whose launching wallet and creator fees the observer recorded live.`);
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
const minAge = opt('min-age', 15);
const limit = opt('limit', 12);
const coins = screenLaunches(db, nowTs - hours * 3600, nowTs - minAge * 60, flag('clean'));
const report = devScreenReport(coins, archetypesById(db), limit);
const solUsd: number = observerStatus(db)?.solUsd ?? 0;

if (flag('json')) {
  const slim = (c: DevCoin) => {
    const { wallets: _w, flow: _f, ...rest } = c;
    return rest;
  };
  console.log(JSON.stringify({ ...report, topCoins: report.topCoins.map(slim) }, null, 2));
  process.exit(0);
}

// ---- Plain-text rendering ----

const short = (a: string | null | undefined) => (a ? `${a.slice(0, 4)}…${a.slice(-4)}` : '-');
const pct = (x: number | null | undefined) => (x === null || x === undefined ? '-' : `${Math.round(x * 100)}%`);
const num = (x: number | null | undefined, d = 2) => (x === null || x === undefined ? '-' : x.toFixed(d));
const dur = (s: number | null | undefined) => {
  if (s === null || s === undefined) return '-';
  return s < 60 ? `${Math.round(s)}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${(s / 3600).toFixed(1)}h`;
};
const usd = (sol: number | null | undefined) =>
  sol === null || sol === undefined || !solUsd ? '' : ` ($${Math.round(sol * solUsd).toLocaleString('en-US')})`;

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

const heading = (t: string) => console.log(`\n== ${t} ==`);

type Profile = ReturnType<typeof devScreenReport>['summary']['all'];
function profiles(cols: Record<string, Profile>): void {
  const rows: [string, (p: Profile) => string | number][] = [
    ['coins', (p) => p.coins],
    ['creator profitable', (p) => pct(p.devProfitableShare)],
    ['median creator result SOL', (p) => num(p.medianDevPnl, 3)],
    ['mean creator result SOL', (p) => num(p.meanDevPnl, 3)],
    ['total creator result SOL', (p) => num(p.totalDevPnl, 1)],
    ['  of which creator fees SOL', (p) => num(p.totalFees, 1)],
    ['median dev buy SOL', (p) => num(p.medianDevBuySol)],
    ['no dev buy', (p) => pct(p.noDevBuyShare)],
    ['median first sell', (p) => dur(p.medianFirstSellSec)],
    ['median buyers before first sell', (p) => num(p.medianBuyersBeforeSell, 0)],
    ['median buy SOL before first sell', (p) => num(p.medianBuySolBeforeSell)],
    ['median mcap multiple at first sell', (p) => num(p.medianMcapMultipleAtSell)],
    ['median share of peak at first sell', (p) => pct(p.medianShareOfPeakAtSell)],
    ['median organic buyers', (p) => num(p.medianOrganicBuyers, 0)],
    ['median organic buy SOL', (p) => num(p.medianOrganicBuySol)],
    ['bundle-like', (p) => pct(p.bundleLikeShare)],
    ['sells with no recorded buy (mostly routers)', (p) => pct(p.tokensMovedShare)],
    ['Mayhem mode', (p) => pct(p.mayhemShare)],
    ['median Mayhem-agent SOL before first dev sell', (p) => num(p.medianAgentSolBeforeSell)],
    ['Mayhem agent net SOL (negative = agent put SOL in)', (p) => num(p.agentNetSol, 1)],
    ['any socials (metadata known)', (p) => `${pct(p.socialsShare)} of ${p.metadataKnown}`],
    ['X/Twitter link', (p) => pct(p.twitterShare)],
    ['graduated', (p) => pct(p.graduatedShare)],
    ['launch signer is not the creator', (p) => pct(p.launcherNotCreatorShare)],
  ];
  table(rows.map(([label, f]) => Object.fromEntries([['', label], ...Object.entries(cols).map(([k, p]) => [k, f(p)])])));
}

const s = report.summary;
heading(`Dev screen: launches ${hours}h back, at least ${minAge}m old`);
console.log(
  `  ${s.launches} launches screened (launch buyouts and non-SOL coins excluded); ${s.active} had trading activity ` +
    `(${report.thresholds.activeMinBuyers}+ buyers after the launch window, ${report.thresholds.activeMinBuySol}+ SOL).`,
);
console.log(
  `  Dev = the creator plus the wallet that signed the launch. Result = SOL out - SOL in + what unsold tokens would return` +
    ` sold into the curve + creator fees.`,
);
console.log(
  `  Fees measured on ${s.feesMeasured} coins, estimated at 0.3% of volume on the rest (~). Curve trades only; tips and` +
    ` priority fees are not visible. Bags marked * are on graduated coins, shown at the last price and left out of the result.`,
);
profiles({ all: s.all, 'with activity': s.activeCoins, 'no activity': s.inactiveCoins });

heading('Coins with activity: creator made money vs. not');
profiles(report.profitableVsLosing);

heading('Coins with activity: normal launches vs. Mayhem mode (pump.fun agent trades the coin for 24h)');
profiles(report.byMode);

heading('Single-wallet clean devs (how this project launches) vs. the rest');
console.log(
  '  Clean = creator and signer are one wallet, and fewer than 2 other wallets bought in the launch slot or sold with the dev.',
);
profiles({ 'single-wallet clean': report.cleanVsBundled.clean, rest: report.cleanVsBundled.bundled });

type Exits = typeof report.exits.all;
function exitTables(label: string, e: Exits): void {
  heading(`How devs sold: ${label}`);
  table(
    e.styles.map((r) => ({
      style: r.style,
      coins: r.coins,
      'dev profitable': pct(r.profitableShare),
      'median result SOL': num(r.medianDevPnl, 3),
      'median organic buyers': num(r.medianOrganicBuyers, 0),
      graduated: r.graduated,
    })),
  );
  heading(`When the dev first sold vs. result: ${label}`);
  table(
    e.timing.map((r) => ({
      'first sell': r.firstSell,
      coins: r.coins,
      'dev profitable': pct(r.profitableShare),
      'median result SOL': num(r.medianDevPnl, 3),
      'buy SOL before sell': num(r.medianBuySolBefore),
      'organic buyers': num(r.medianOrganicBuyers, 0),
      'coin peaked later': pct(r.peakAfterSellShare),
    })),
  );
  heading(`Net SOL other wallets put in before the first dev sell vs. result: ${label}`);
  table(
    e.inflow.map((r) => ({
      'net inflow': r.netInflowBeforeSell,
      coins: r.coins,
      'dev profitable': pct(r.profitableShare),
      'median result SOL': num(r.medianDevPnl, 3),
      'median dev buy SOL': num(r.medianDevBuySol),
      'median result per SOL of dev buy': num(r.medianResultPerDevBuy),
    })),
  );
}
exitTables('all devs, coins with activity', report.exits.all);
exitTables('single-wallet clean devs, coins with activity', report.exits.singleWalletClean);
exitTables('single-wallet clean devs, normal (non-Mayhem) coins with activity', report.exits.singleWalletCleanNormal);

const coinRows = (xs: DevCoin[]) =>
  xs.map((c) => ({
    coin: `${c.info.symbol ?? '?'} ${short(c.info.mint)}`,
    dev: short(c.info.launcher ?? c.info.creator),
    'dev buy': num(c.devBuySol),
    result: num(c.devTotalPnl) + usd(c.devTotalPnl),
    fees: num(c.feesSol) + (c.feesEstimated ? '~' : ''),
    bag: c.devGraduatedBagSol ? `${num(c.devGraduatedBagSol)}*` : num(c.devBagSol),
    style: c.style,
    'sells': c.devSells,
    '1st sell': dur(c.firstSell?.ageSec),
    'buyers before': c.firstSell?.buyersBefore ?? '-',
    'SOL in before': num(c.firstSell?.buySolBefore),
    'x mcap': num(c.firstSell?.mcapMultiple, 1),
    'of peak': pct(c.firstSell?.shareOfPeak),
    'organic': c.organicBuyers,
    'same slot': c.sameSlotBuyers,
    'sold with dev': c.coordinatedSellers,
    mayhem: c.info.isMayhem ? 'yes' : '',
    'agent SOL in': c.info.isMayhem ? num(c.agentBuySolBeforeSell, 1) : '',
    cluster: num(c.clusterPnl),
    socials: c.info.socials ? ['x', 'tg', 'web'].filter((_, i) => [c.info.socials!.twitter, c.info.socials!.telegram, c.info.socials!.website][i]).join('+') || 'none' : '?',
    grad: c.info.graduatedTs !== null ? 'yes' : '',
  }));

heading('Most profitable devs per coin (coins with activity)');
table(coinRows(report.topCoins));

heading('Most profitable single-wallet clean devs per coin');
table(coinRows(report.singleWalletCleanTop));

heading('Devs by total result across all their launches');
const creatorRows = (xs: typeof report.creators) =>
  xs.map((c) => ({
    dev: short(c.creator),
    launches: c.launches,
    active: c.active,
    profitable: c.profitable,
    'total SOL': num(c.totalPnl),
    'cluster SOL': num(c.clusterPnl),
    'fees SOL': num(c.fees),
    'median dev buy': num(c.medianDevBuySol),
    '1st sell': dur(c.medianFirstSellSec),
    'launch gap': dur(c.medianGapSec),
    style: c.mainStyle,
    'bundle-like': c.bundleLike,
    best: c.bestCoin ?? '?',
  }));
table(creatorRows(report.creators));

const sc = report.serialCreators;
heading(`Serial creators (2+ launches in the window): ${sc.count}, ${pct(sc.launchesShare)} of launches, ${pct(sc.profitableShare)} net profitable`);
console.log('  Worst:');
table(creatorRows(sc.bottom));

heading('Trade flow in coins with activity (other wallets, by seconds after launch)');
table(
  report.flow.map((f) => ({
    'up to': dur(f.upToSec),
    buys: f.buys,
    sells: f.sells,
    'buy SOL': num(f.buySol, 1),
    'sell SOL': num(f.sellSol, 1),
    'sell/buy SOL': f.buySol ? num(f.sellSol / f.buySol) : '-',
    'new buyers': f.newBuyers,
    'median new buyers/coin': num(f.medianNewBuyersPerCoin, 0),
  })),
);

heading(`Who buys in the first 5 minutes (${report.buyerStatsCoins} coins with activity still on the curve)`);
table(
  report.composition.map((r) => ({
    wallets: r.kind,
    count: r.wallets,
    'share of buy SOL': pct(r.buySolShare),
    profitable: pct(r.profitableShare),
    'result SOL': num(r.pnlSol, 1),
  })),
);
const cr = report.combinedResult;
console.log(
  `  Check: devs ${num(cr.devs, 1)} + everyone else ${num(cr.others, 1)} + Mayhem agent ${num(cr.agent, 1)} SOL before creator` +
    ` fees = ${num(cr.devs + cr.others + cr.agent, 1)}; this must be negative.`,
);
const lw = report.launchWindowBuyers;
const lb = report.laterBuyers;
console.log(
  `  Launch-window buyers: ${lw.wallets}, ${pct(lw.profitableShare)} profitable, median hold ${dur(lw.medianHoldSec)}, total ${num(lw.totalPnl, 1)} SOL.`,
);
console.log(
  `  Later buyers: ${lb.wallets}, ${pct(lb.profitableShare)} profitable, median hold ${dur(lb.medianHoldSec)}, total ${num(lb.totalPnl, 1)} SOL.`,
);
const b = report.organicBuySize;
console.log(`  Organic buy size per wallet (SOL): p25 ${num(b.p25)}, median ${num(b.p50)}, p75 ${num(b.p75)}, p90 ${num(b.p90)}.`);
const r = report.reactionToDevSell;
console.log(
  `  After the creator's first sell: buying held up (>= half the previous minute) on ${pct(r.buyingContinuedShare)} of ${r.coins} coins; ` +
    `median buy SOL minute before ${num(r.medianBuySolBefore)}, after ${num(r.medianBuySolAfter)}; coin peaked after the sell on ${pct(r.peakAfterSellShare)}.`,
);
console.log();
