import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Curve } from '../chain/curve.ts';
import { config } from '../config.ts';
import { awayFromGaps, feedGaps, loadBacktestCoins } from '../sim/backtest.ts';
import { PHANTOM } from '../sim/flow.ts';

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

if (args.includes('--help')) {
  console.log(`usage: npm run export-paths -- [--out data/exports/paths.jsonl] [--min-dev-buy 1] [--horizon 10]

For exit research. Until we sell the whole bag, our position does not move the curve, so a launch replayed with our
bag in place of the dev's (dev trades removed, sells reacting to the dev held back) has one price path whatever exit
we pick. This writes that path for each launch: before each other wallet's trade, what our whole bag would fetch
sold then, and the creator fees earned so far. Any whole-bag exit's result is then a lookup, so exits can be searched
and learned quickly; the chosen ones are checked in the full replay (npm run simulate).

Each event is [slots after launch, buy 1 / sell 0, SOL in (+) or out (-) of the curve, bag value before the trade,
creator fees before the trade, wallet id or -1 for a trade the feed missed, 1 if the wallet first bought within two
slots of launch].`);
  process.exit(0);
}
if (!existsSync(config.dbPath)) {
  console.error(`No database at ${config.dbPath}. Run "npm run observe" first.`);
  process.exit(1);
}

const db = new DatabaseSync(config.dbPath, { readOnly: true });
db.exec('PRAGMA busy_timeout = 5000;');
const out = opt('out') ?? 'data/exports/paths.jsonl';
const minBuy = Number(opt('min-dev-buy') ?? 1);
const horizonSec = Number(opt('horizon') ?? 10) * 60;
const nowTs = Math.floor(Date.now() / 1000);

const all = loadBacktestCoins(db, 0, nowTs - horizonSec).sort((a, b) => a.createdTs - b.createdTs);
const gaps = all.length ? feedGaps(db, all[0]!.createdTs, nowTs) : [];
const coins = awayFromGaps(all, gaps, horizonSec).filter((c) => c.launchBuySol >= minBuy);
const r6 = (x: number) => Math.round(x * 1e6) / 1e6;

mkdirSync(dirname(out), { recursive: true });
const lines: string[] = [];
for (const c of coins) {
  const curve = new Curve();
  const own = curve.buy(c.launchBuySol);
  let fees = own.creatorFee;
  const launchSlot = c.trades[0]!.slot;
  const held = new Map<number, { recorded: number; replayed: number }>();
  const early = new Set<number>();
  const events: number[][] = [];
  for (const t of c.trades) {
    if (t.ts - c.createdTs > horizonSec || curve.complete) break;
    if (t.dev || t.reaction) continue;
    const value = curve.sellValue(own.tokens);
    const feesBefore = fees;
    let sol: number;
    if (t.isBuy) {
      const r = curve.buy(t.sol);
      fees += r.creatorFee;
      sol = r.sol;
      if (t.wallet !== PHANTOM) {
        const h = held.get(t.wallet) ?? { recorded: 0, replayed: 0 };
        h.recorded += t.tokens;
        h.replayed += r.tokens;
        held.set(t.wallet, h);
        if (t.slot - launchSlot <= 2) early.add(t.wallet);
      }
    } else {
      const h = held.get(t.wallet);
      let amount = t.tokens;
      if (h && h.recorded > 0) {
        const share = Math.min(1, t.tokens / h.recorded);
        amount = share * h.replayed;
        h.recorded -= share * h.recorded;
        h.replayed -= amount;
      }
      const r = curve.sell(amount);
      fees += r.creatorFee;
      sol = -r.sol;
    }
    events.push([t.slot - launchSlot, t.isBuy ? 1 : 0, r6(sol), r6(value), r6(feesBefore), t.wallet, early.has(t.wallet) ? 1 : 0]);
  }
  lines.push(
    JSON.stringify({
      mint: c.mint,
      ts: c.createdTs,
      dev: c.dev,
      clean: c.clean,
      active: c.active,
      spent: r6(own.sol),
      tokens: own.tokens,
      endValue: r6(curve.sellValue(own.tokens)),
      endFees: r6(fees),
      graduated: curve.complete,
      events,
    }),
  );
}
writeFileSync(out, lines.join('\n') + '\n');
console.log(`Wrote ${lines.length} launch paths (dev buy ${minBuy}+ SOL, ${horizonSec / 60} min) to ${out}.`);
