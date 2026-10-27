import { DatabaseSync } from 'node:sqlite';
import { decodeTx } from '../chain/decoder.ts';
import { config, redactUrl } from '../config.ts';
import { log } from '../log.ts';
import { Store } from '../store/db.ts';

/**
 * Looks up the wallet that signed each launch for coins recorded before the observer stored it, by fetching the
 * create transaction. Busiest coins first.
 */

const args = process.argv.slice(2);
const opt = (name: string, fallback: number) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};
const hours = opt('hours', 24);
const concurrency = opt('concurrency', 4);

// Opening the store applies schema changes (the launchers table) before the lookups start.
new Store(config.dbPath).close();
const db = new DatabaseSync(config.dbPath);
db.exec('PRAGMA busy_timeout = 10000;');
const sinceTs = Math.floor(Date.now() / 1000) - hours * 3600;
// --ambiguous: only coins with 10+ later buyers whose first launch-second buyer is not the creator, i.e. where the
// launcher could be a different wallet that bought. The public RPC allows only a few lookups a minute.
const ambiguous = args.includes('--ambiguous');
const todo = db
  .prepare(
    `SELECT c.mint, c.create_sig FROM coins c LEFT JOIN launchers l ON l.mint = c.mint
     WHERE c.created_ts >= ? AND c.launcher IS NULL AND l.mint IS NULL AND c.create_sig IS NOT NULL
       AND (? = 0 OR (c.unique_buyers - c.early_buyers >= 10 AND (
         SELECT i.address FROM trades t JOIN ids i ON i.id = t.wallet_id
         WHERE t.mint_id = (SELECT id FROM ids WHERE address = c.mint) AND t.ts = c.created_ts AND t.is_buy = 1
         ORDER BY t.rowid LIMIT 1) != c.creator))
     ORDER BY c.unique_buyers DESC`,
  )
  .all(sinceTs, ambiguous ? 1 : 0) as { mint: string; create_sig: string }[];
const put = db.prepare('INSERT OR REPLACE INTO launchers (mint, launcher) VALUES (?, ?)');
log.info('looking up launchers', { coins: todo.length, rpc: redactUrl(config.rpcHttp) });

async function fetchTx(sig: string): Promise<{ slot: number; meta: { logMessages: string[] } } | null> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(config.rpcHttp, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getTransaction',
        params: [sig, { maxSupportedTransactionVersion: 0, encoding: 'json', commitment: 'confirmed' }],
      }),
    });
    if (res.status === 429 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      continue;
    }
    const body = (await res.json()) as { result?: { slot: number; meta: { logMessages: string[] } } | null };
    return body.result ?? null;
  }
  return null;
}

let next = 0;
let found = 0;
let missing = 0;
async function worker(): Promise<void> {
  while (next < todo.length) {
    const { mint, create_sig } = todo[next++]!;
    const tx = await fetchTx(create_sig);
    const launch = tx
      ? decodeTx({ sig: create_sig, slot: tx.slot, logs: tx.meta.logMessages, receivedAt: 0 }).events.find(
          (e) => e.kind === 'launch' && e.mint === mint,
        )
      : undefined;
    if (launch?.kind === 'launch') {
      put.run(mint, launch.user);
      found++;
    } else missing++;
    if ((found + missing) % 100 === 0) log.info('progress', { done: found + missing, of: todo.length, missing });
  }
}

await Promise.all(Array.from({ length: concurrency }, worker));
log.info('done', { found, missing });
db.close();
