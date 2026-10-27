import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CURVE_FEE_RATE, CURVE_REAL_TOKENS } from '../chain/curve.ts';
import { config } from '../config.ts';
import { PLAYBOOK, PLAYBOOKS } from '../playbook.ts';
import { awayFromGaps, feedGaps, loadBacktestCoins } from '../sim/backtest.ts';
import { PHANTOM } from '../sim/flow.ts';
import { RECORDED_DEV } from '../sim/policies.ts';
import { DEFAULT_SIM, SLOT_SEC, simulate } from '../sim/simulate.ts';
import { launchTool, WAVE_SEC, xLinkKind } from '../sim/traits.ts';
import { tweetTs, xHandle } from '../intel/xlinks.ts';

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

if (args.includes('--help')) {
  console.log(`usage: npm run export-launches -- [--out data/exports/launches.jsonl] [--horizon 10]

Writes one JSON line per normal, standard-curve launch whose dev bought in the create transaction: what was known at
launch (dev buy, links, launch tool, ticker wave, the dev's history, the X post's age), the outside flow it drew, how
the recorded dev bought and sold, and what the recorded dev and each playbook's exit made in the replay. The model
scripts in ml/ read this file.`);
  process.exit(0);
}

if (!existsSync(config.dbPath)) {
  console.error(`No database at ${config.dbPath}. Run "npm run observe" first.`);
  process.exit(1);
}

const db = new DatabaseSync(config.dbPath, { readOnly: true });
db.exec('PRAGMA busy_timeout = 5000;');
const out = opt('out') ?? 'data/exports/launches.jsonl';
const options = { ...DEFAULT_SIM, horizonSec: Number(opt('horizon') ?? 10) * 60 };
const nowTs = Math.floor(Date.now() / 1000);
/** SOL into the curve for the same-flow replays. */
const COUNTERFACTUAL_BUYS = [1, 2, 3, 4, 5, 7, 10];
const until = nowTs - options.horizonSec;

const coins = loadBacktestCoins(db, 0, until).sort((a, b) => a.createdTs - b.createdTs);
if (!coins.length) {
  console.error('No launches to export.');
  process.exit(1);
}
const gaps = feedGaps(db, coins[0]!.createdTs, nowTs);
const clearOfGaps = new Set(awayFromGaps(coins, gaps, options.horizonSec).map((c) => c.mint));

interface Row {
  mint: string;
  name: string | null;
  symbol: string | null;
  uri: string | null;
  ts: number;
  dev: string;
  busy: number;
  meta_status: string;
  twitter: string | null;
  telegram: string | null;
  website: string | null;
  description: string | null;
  peak_mcap_sol: number;
  is_mayhem: number;
}
const all = db
  .prepare(
    `SELECT mint, name, symbol, uri, created_ts AS ts, COALESCE(launcher, creator) AS dev,
       unique_buyers - early_buyers >= 10 AS busy, meta_status, twitter, telegram, website, description,
       peak_mcap_sol, is_mayhem
     FROM coins WHERE quote = 'SOL' ORDER BY created_ts`,
  )
  .all() as unknown as Row[];
const byMint = new Map(all.map((r) => [r.mint, r]));
/** The website's host, '' for none, '?' for text that is not a link. */
const siteHost = (site: string | null): string => {
  if (!site?.trim()) return '';
  const m = site.trim().match(/(?:https?:\/\/)?([a-z0-9.-]+\.[a-z]{2,})/i);
  return m ? m[1]!.toLowerCase().replace(/^www\./, '') : '?';
};
const norm = (s: string | null) => (s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const byTicker = new Map<string, Row[]>();
const byDev = new Map<string, Row[]>();
for (const r of all) {
  const k = norm(r.symbol);
  if (k) byTicker.set(k, [...(byTicker.get(k) ?? []), r]);
  byDev.set(r.dev, [...(byDev.get(r.dev) ?? []), r]);
}

mkdirSync(dirname(out), { recursive: true });
const lines: string[] = [];
for (const c of coins) {
  const r = byMint.get(c.mint);
  const launchSlot = c.trades[0]!.slot;
  const age = (slot: number) => (slot - launchSlot) * SLOT_SEC;

  // Outside flow: every wallet but the dev's, phantom fills included (they are trades the feed missed).
  const outsideBuy = (maxAge: number) =>
    c.trades.filter((t) => !t.dev && t.isBuy && age(t.slot) <= maxAge).reduce((s, t) => s + t.sol, 0);
  const outsideNet = (maxAge: number) =>
    c.trades.filter((t) => !t.dev && age(t.slot) <= maxAge).reduce((s, t) => s + (t.isBuy ? t.sol : -t.sol), 0);
  // Sniper wallets: others whose first buy landed within two slots of launch.
  const firstBuySlot = new Map<number, number>();
  for (const t of c.trades) if (!t.dev && t.isBuy && t.wallet !== PHANTOM && !firstBuySlot.has(t.wallet)) firstBuySlot.set(t.wallet, t.slot);
  const snipers = new Set([...firstBuySlot].filter(([, slot]) => slot - launchSlot <= 2).map(([w]) => w));
  const sniperTrades = c.trades.filter((t) => snipers.has(t.wallet) && age(t.slot) <= options.horizonSec);
  const sniperFirstSell = new Map<number, number>();
  for (const t of sniperTrades) if (!t.isBuy && !sniperFirstSell.has(t.wallet)) sniperFirstSell.set(t.wallet, age(t.slot));
  const sniperSellAges = [...sniperFirstSell.values()].sort((a, b) => a - b);
  const buyersBy = (maxAge: number) =>
    new Set(c.trades.filter((t) => !t.dev && t.isBuy && t.wallet !== PHANTOM && age(t.slot) <= maxAge).map((t) => t.wallet)).size;

  // The recorded dev's trades: each sell as a share of the most the dev held.
  let held = 0;
  let peakHeld = 0;
  let launchTokens = 0;
  let laterBuySol = 0;
  const sells: [number, number, number][] = [];
  for (const t of c.trades) {
    if (!t.dev) continue;
    if (t.isBuy) {
      held += t.tokens;
      peakHeld = Math.max(peakHeld, held);
      if (t.slot === launchSlot) launchTokens += t.tokens;
      else laterBuySol += t.sol;
    } else {
      sells.push([Math.round(age(t.slot) * 10) / 10, peakHeld > 0 ? t.tokens / peakHeld : 0, t.sol]);
      held = Math.max(0, held - t.tokens);
    }
  }
  const soldBy = (maxAge: number) => sells.filter(([a]) => a <= maxAge).reduce((s, [, share]) => s + share, 0);
  const firstSellAge = sells[0]?.[0] ?? null;
  const netBeforeFirstSell = firstSellAge === null ? outsideNet(options.horizonSec) : outsideNet(firstSellAge - SLOT_SEC / 2);

  const sim = (p: typeof RECORDED_DEV) => {
    const s = simulate(c, p, options);
    return { pnl: s.pnl, firstSellSec: s.firstSellSec };
  };
  const wave = r ? (byTicker.get(norm(r.symbol)) ?? []).filter((x) => x.ts < c.createdTs && x.ts >= c.createdTs - WAVE_SEC) : [];
  const prior = (byDev.get(c.dev) ?? []).filter((x) => x.ts < c.createdTs);
  const metaKnown = r?.meta_status === 'done';
  const tweetAt = metaKnown ? tweetTs(r?.twitter ?? null) : null;

  lines.push(
    JSON.stringify({
      mint: c.mint,
      ts: c.createdTs,
      dev: c.dev,
      name: r?.name ?? null,
      symbol: c.symbol,
      clearOfGaps: clearOfGaps.has(c.mint),
      clean: c.clean,
      active: c.active,
      graduated: c.graduated,
      phantomSol: c.phantomSol,
      // Known at launch.
      devBuySol: c.launchBuySol,
      devBuyShare: launchTokens / CURVE_REAL_TOKENS,
      tool: launchTool(r?.uri ?? null),
      metaKnown,
      xLink: xLinkKind(metaKnown, r?.twitter ?? null),
      xHandle: metaKnown ? xHandle(r?.twitter ?? null) : null,
      tweetAgeSec: tweetAt === null ? null : c.createdTs - tweetAt,
      website: metaKnown ? siteHost(r?.website ?? null) : null,
      telegram: metaKnown ? Boolean(r?.telegram) : null,
      descriptionLength: metaKnown ? (r?.description ?? '').length : null,
      description: metaKnown ? (r?.description ?? '').slice(0, 300) : null,
      twitterLink: metaKnown ? (r?.twitter ?? null) : null,
      nameLength: (r?.name ?? '').length,
      symbolLength: (c.symbol ?? '').length,
      waveBefore: wave.length,
      waveBusyBefore: wave.filter((x) => x.busy).length,
      devPriorLaunches: prior.length,
      devPriorBusy: prior.filter((x) => x.busy).length,
      devPriorMayhem: prior.filter((x) => x.is_mayhem).length,
      devLastLaunchAgoSec: prior.length ? c.createdTs - prior.at(-1)!.ts : null,
      hourUtc: new Date(c.createdTs * 1000).getUTCHours(),
      // What it drew.
      outsideBuy1s: outsideBuy(1.2),
      outsideBuy3s: outsideBuy(3),
      outsideBuy10s: outsideBuy(10),
      outsideBuy60s: outsideBuy(60),
      outsideNet10s: outsideNet(10),
      outsideNet60s: outsideNet(60),
      outsideNet600s: outsideNet(600),
      buyers10s: buyersBy(10),
      buyers60s: buyersBy(60),
      buyers600s: buyersBy(600),
      snipers: snipers.size,
      sniperBuySol: sniperTrades.filter((t) => t.isBuy).reduce((a, t) => a + t.sol, 0),
      sniperSellSol30s: sniperTrades.filter((t) => !t.isBuy && age(t.slot) <= 30).reduce((a, t) => a + t.sol, 0),
      sniperSellSol: sniperTrades.filter((t) => !t.isBuy).reduce((a, t) => a + t.sol, 0),
      sniperFirstSellMedianSec: sniperSellAges.length ? sniperSellAges[Math.floor(sniperSellAges.length / 2)]! : null,
      peakMcapSol: r?.peak_mcap_sol ?? null,
      // What the recorded dev did.
      devLaterBuySol: laterBuySol,
      devSells: sells,
      devFirstSellSec: firstSellAge,
      devSoldBy10s: soldBy(10),
      devSoldBy30s: soldBy(30),
      devSoldBy60s: soldBy(60),
      devSoldBy300s: soldBy(300),
      devSoldByEnd: soldBy(Infinity),
      netBeforeFirstSell,
      // Results in the replay (SOL, creator fees and costs included).
      pnlRecorded: sim(RECORDED_DEV),
      recordedTradingPnl: c.recordedTradingPnl,
      ...Object.fromEntries(PLAYBOOKS.map((p) => [`pnlV${p.version}`, sim(p.exit)])),
      // The current exit with a different dev buy under the same outside flow: what bag size alone does.
      ...Object.fromEntries(COUNTERFACTUAL_BUYS.map((b) => [`pnlAt${b}`, sim({ ...PLAYBOOK.exit, devBuySol: b * (1 + CURVE_FEE_RATE) })])),
    }),
  );
}
writeFileSync(out, lines.join('\n') + '\n');
console.log(
  `Wrote ${lines.length} launches (${clearOfGaps.size} clear of feed gaps) to ${out}; playbook v${PLAYBOOK.version}, horizon ${options.horizonSec / 60} min.`,
);
