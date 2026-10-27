import { config } from '../config.ts';

/**
 * On-chain history of a wallet beyond what the observer has seen: how many transactions it has made, when it was
 * first funded, and by whom. Usage: npm run wallet-history -- <wallet> [<wallet> ...] [--json]
 */

const args = process.argv.slice(2);
const wallets = args.filter((a) => !a.startsWith('--'));
const asJson = args.includes('--json');
const MAX_PAGES = 5;

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(config.rpcHttp, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    if (res.status === 429 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      continue;
    }
    const body = (await res.json()) as { result: T; error?: { message: string } };
    if (body.error) throw new Error(body.error.message);
    return body.result;
  }
  throw new Error(`${method} rate limited`);
}

interface SigInfo {
  signature: string;
  blockTime: number | null;
  err: unknown;
}

async function history(wallet: string) {
  const sigs: SigInfo[] = [];
  let before: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const batch = await rpc<SigInfo[]>('getSignaturesForAddress', [wallet, { limit: 1000, ...(before ? { before } : {}) }]);
    sigs.push(...batch);
    if (batch.length < 1000) break;
    before = batch[batch.length - 1]!.signature;
  }
  const complete = sigs.length < MAX_PAGES * 1000;
  const oldest = sigs[sigs.length - 1];
  let fundedBy: string | null = null;
  let fundedSol: number | null = null;
  if (oldest && complete) {
    const tx = await rpc<any>('getTransaction', [oldest.signature, { maxSupportedTransactionVersion: 0, encoding: 'json' }]);
    if (tx) {
      const keys: string[] = [
        ...tx.transaction.message.accountKeys,
        ...(tx.meta.loadedAddresses?.writable ?? []),
        ...(tx.meta.loadedAddresses?.readonly ?? []),
      ];
      const delta = (i: number) => (tx.meta.postBalances[i] - tx.meta.preBalances[i]) / 1e9;
      const me = keys.indexOf(wallet);
      if (me >= 0 && delta(me) > 0) {
        fundedSol = delta(me);
        // The funder is the account that lost the most SOL in that transaction.
        let worst = -1;
        keys.forEach((_, i) => {
          if (i !== me && (worst < 0 || delta(i) < delta(worst))) worst = i;
        });
        fundedBy = worst >= 0 ? keys[worst]! : null;
      }
    }
  }
  const times = sigs.flatMap((s) => (s.blockTime ? [s.blockTime] : []));
  return {
    wallet,
    transactions: complete ? sigs.length : `${sigs.length}+`,
    failed: sigs.filter((s) => s.err).length,
    firstSeen: complete && oldest?.blockTime ? new Date(oldest.blockTime * 1000).toISOString() : null,
    lastSeen: times.length ? new Date(Math.max(...times) * 1000).toISOString() : null,
    // When the history is longer than we fetch: how far back the fetched transactions reach.
    fetchedSince: times.length ? new Date(Math.min(...times) * 1000).toISOString() : null,
    ageHours: complete && oldest?.blockTime ? Math.round((Date.now() / 1000 - oldest.blockTime) / 360) / 10 : null,
    fundedBy,
    fundedSol,
  };
}

const out = [];
for (const w of wallets) out.push(await history(w));
if (asJson) console.log(JSON.stringify(out, null, 2));
else for (const h of out) console.log(Object.entries(h).map(([k, v]) => `${k}=${v}`).join('  '));
