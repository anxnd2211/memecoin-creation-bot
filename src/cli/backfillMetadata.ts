import { config } from '../config.ts';
import { log } from '../log.ts';
import { MetadataFetcher } from '../market/metadata.ts';
import { Store } from '../store/db.ts';

/**
 * Fetches metadata (description, image, socials) for normal SOL launches the observer did not fetch it for. Until
 * every launch was fetched at launch time, only coins that drew buyers and a 5% sample were, so comparing traits of
 * busy and dead launches needs this first. Only coins idle for three hours are touched: the observer has dropped them
 * from memory and will not overwrite what is written here.
 * Usage: npm run backfill-metadata -- --since 2026-10-27T04:22Z [--until <date>] [--concurrency 6] [--retry-failed]
 * Metadata hosts rate-limit bursts; retry failures with a low --concurrency.
 */

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const date = (name: string, fallback: number) => {
  const v = opt(name);
  if (v === undefined) return fallback;
  const ms = Date.parse(v);
  if (Number.isNaN(ms)) {
    console.error(`--${name} expects a date such as 2026-10-27T04:22Z, got ${v}`);
    process.exit(1);
  }
  return Math.floor(ms / 1000);
};
const nowTs = Math.floor(Date.now() / 1000);
const sinceTs = date('since', nowTs - 86_400);
const untilTs = date('until', nowTs);
const concurrency = Number(opt('concurrency') ?? 6);
const statuses = args.includes('--retry-failed') ? ['none', 'failed'] : ['none'];
/** The observer drops coins idle this long from memory (engine sweep). */
const OBSERVER_IDLE_SEC = 3 * 3600;

const store = new Store(config.dbPath);
const todo = store.db
  .prepare(
    `SELECT mint, uri FROM coins
     WHERE created_ts BETWEEN ? AND ? AND quote = 'SOL' AND is_mayhem = 0
       AND meta_status IN (${statuses.map(() => '?').join(', ')}) AND uri IS NOT NULL AND uri != ''
       AND COALESCE(last_trade_ts, created_ts) < ?
     ORDER BY created_ts`,
  )
  .all(sinceTs, untilTs, ...statuses, nowTs - OBSERVER_IDLE_SEC) as { mint: string; uri: string }[];
log.info('fetching metadata', { coins: todo.length, concurrency });

let finished = 0;
let next = 0;
await new Promise<void>((resolve) => {
  if (!todo.length) resolve();
  // Hand coins to the fetcher a few at a time, so its queue never fills.
  const feed = () => {
    while (next < todo.length && fetcher.queued < concurrency) {
      const c = todo[next++]!;
      fetcher.enqueue(c.mint, c.uri);
    }
  };
  const fetcher = new MetadataFetcher(
    config.ipfsGateways,
    (mint, status, meta) => {
      store.saveCoinMeta(mint, status, meta);
      finished++;
      if (finished % 200 === 0) log.info('metadata progress', { finished, of: todo.length, ...fetcher.stats });
      if (finished === todo.length) resolve();
      else feed();
    },
    concurrency,
  );
  feed();
});
log.info('metadata backfill done', { finished });
store.close();
