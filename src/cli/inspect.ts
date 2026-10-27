import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config.ts';
import { ARCHETYPES, bestWindow } from '../intel/classify.ts';
import { observerStatus, walletSummary } from '../intel/reports.ts';
import { HOLD_BUCKETS } from '../intel/state.ts';

const address = process.argv[2];
if (!address || address.startsWith('--')) {
  console.error('usage: npm run inspect -- <wallet or coin mint address>');
  process.exit(1);
}
if (!existsSync(config.dbPath)) {
  console.error(`No database at ${config.dbPath}. Run "npm run observe" first.`);
  process.exit(1);
}

const db = new DatabaseSync(config.dbPath, { readOnly: true });
db.exec('PRAGMA busy_timeout = 5000;');
const nowTs = Math.floor(Date.now() / 1000);
const solUsd: number = observerStatus(db)?.solUsd ?? 0;
const ago = (ts: number | null) => (ts === null ? '-' : `${Math.round((nowTs - ts) / 60)}m ago`);
const usd = (sol: number | null) => (sol === null || !solUsd ? '-' : `$${Math.round(sol * solUsd).toLocaleString()}`);

const coin = db.prepare('SELECT * FROM coins WHERE mint = ?').get(address) as Record<string, any> | undefined;
const wallet = db.prepare('SELECT * FROM wallet_stats WHERE wallet = ?').get(address) as Record<string, any> | undefined;

if (!coin && !wallet) {
  console.log('Not seen by the observer yet.');
  process.exit(0);
}

if (coin) {
  console.log(`\nCoin ${coin.symbol ?? '?'} (${coin.name ?? 'unknown name'})  ${coin.mint}`);
  console.log(`  creator ${coin.creator ?? '-'} | launched ${ago(coin.created_ts)} | quote ${coin.quote}`);
  console.log(
    `  peak ${usd(coin.peak_mcap_sol)} (${coin.peak_ts && coin.created_ts ? `${Math.round((coin.peak_ts - coin.created_ts) / 60)}m after launch` : '-'}) | now ${usd(coin.last_mcap_sol)} | volume ${coin.volume_sol.toFixed(1)} SOL`,
  );
  console.log(
    `  buyers ${coin.unique_buyers} (launch-second ${coin.early_buyers}) | trades ${coin.trades} | smart-money entries ${coin.smart_buys}`,
  );
  console.log(
    `  dev bought ${Math.round(coin.dev_bought).toLocaleString()} tokens, sold ${Math.round(coin.dev_sold).toLocaleString()} ` +
      `| first sell ${coin.dev_first_sell_ts ? `${coin.dev_first_sell_ts - coin.created_ts}s after launch` : 'never'}`,
  );
  console.log(`  graduated ${coin.graduated_ts ? ago(coin.graduated_ts) : 'no'} | pool ${coin.pool ?? '-'}`);
  if (coin.description || coin.twitter) {
    console.log(`  twitter ${coin.twitter ?? '-'} | website ${coin.website ?? '-'}`);
    console.log(`  description: ${coin.description ?? '-'}`);
  }
  const cps = JSON.parse(coin.checkpoints) as Record<string, { buyers: number; mcapSol: number | null; volumeSol: number }>;
  for (const [sec, cp] of Object.entries(cps)) {
    console.log(`  at ${Number(sec) / 60}m: ${cp.buyers} buyers, mcap ${usd(cp.mcapSol)}, volume ${cp.volumeSol.toFixed(1)} SOL`);
  }
  const holders = db
    .prepare(
      `SELECT w.address, p.tokens, p.cost_sol, p.realized_sol, p.entry_delay, ws.archetypes
       FROM positions p JOIN ids w ON w.id = p.wallet_id JOIN ids m ON m.id = p.mint_id
       LEFT JOIN wallet_stats ws ON ws.wallet = w.address
       WHERE m.address = ? ORDER BY p.tokens DESC LIMIT 15`,
    )
    .all(coin.mint) as Record<string, any>[];
  console.log('  largest observed holders:');
  for (const h of holders) {
    const supplyShare = (h.tokens / 1e9) * 100;
    console.log(
      `    ${h.address}  ${supplyShare.toFixed(2)}% supply  cost ${h.cost_sol.toFixed(2)} SOL  realized ${h.realized_sol.toFixed(2)}  ` +
        `entered ${h.entry_delay ?? '?'}s after launch  ${h.archetypes ?? ''}`,
    );
  }
}

if (wallet) {
  const w = walletSummary(wallet, nowTs);
  const hourHist = JSON.parse(wallet.hour_hist) as number[];
  const holdHist = JSON.parse(wallet.hold_hist) as number[];
  const win = bestWindow(hourHist);
  console.log(`\nWallet ${w.wallet}`);
  console.log(`  archetypes: ${w.archetypes.length ? w.archetypes.map((a) => `${a} (${ARCHETYPES[a]})`).join('; ') : 'none yet'}`);
  console.log(
    `  realized ${w.realizedSol.toFixed(2)} SOL | win rate ${w.winRate === null ? '-' : Math.round(w.winRate * 100) + '%'} over ${w.closed} closed | ` +
      `${w.trades} trades (~${Math.round(w.tradesPerDay)}/day) | active ${w.activeDays} day(s), last ${ago(w.lastTs)}`,
  );
  console.log(
    `  avg buy ${w.avgBuySol?.toFixed(2) ?? '-'} SOL, max ${w.maxBuySol.toFixed(2)} | snipes ${w.snipeShare === null ? '-' : Math.round(w.snipeShare * 100) + '%'} ` +
      `| max open ${w.maxOpen} | coins launched ${w.launches}`,
  );
  console.log(`  busiest 3h window: ${win.startHour}:00-${(win.startHour + 3) % 24}:00 UTC (${Math.round(win.share * 100)}% of trades)`);
  console.log(
    `  hold times: ${holdHist
      .map((n, i) => (n ? `${HOLD_BUCKETS[i] === Infinity ? '>1d' : '<=' + HOLD_BUCKETS[i] + 's'}: ${n}` : ''))
      .filter(Boolean)
      .join(', ') || '-'}`,
  );
  const positions = db
    .prepare(
      `SELECT m.address mint, c.symbol, p.tokens, p.cost_sol, p.proceeds_sol, p.realized_sol, p.first_ts, p.closed_ts, p.complete
       FROM positions p JOIN ids w ON w.id = p.wallet_id JOIN ids m ON m.id = p.mint_id
       LEFT JOIN coins c ON c.mint = m.address
       WHERE w.address = ? ORDER BY p.last_ts DESC LIMIT 20`,
    )
    .all(w.wallet) as Record<string, any>[];
  console.log('  recent positions:');
  for (const p of positions) {
    console.log(
      `    ${(p.symbol ?? '?').padEnd(10)} ${p.mint}  cost ${p.cost_sol.toFixed(2)}  out ${p.proceeds_sol.toFixed(2)}  ` +
        `realized ${p.realized_sol.toFixed(2)}  ${p.closed_ts ? `closed after ${p.closed_ts - p.first_ts}s` : 'open'}${p.complete ? '' : '  (partly before observer)'}`,
    );
  }
}
console.log();
