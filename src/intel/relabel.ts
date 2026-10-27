import type { Store } from '../store/db.ts';
import { CLASSIFY_VERSION, classify } from './classify.ts';
import { walletFromRow } from './state.ts';

/**
 * Recomputes every stored wallet's archetypes when the rules changed since the labels were written. Labels are
 * otherwise only refreshed when a wallet trades, so idle wallets would keep labels from old rules forever.
 * Returns the number of wallets whose labels changed, or null when the rules are unchanged.
 */
export function relabelWalletsIfRulesChanged(store: Store, nowTs: number): number | null {
  if (store.getMeta<number>('classify_version') === CLASSIFY_VERSION) return null;
  const changed: [string, string[]][] = [];
  for (const row of store.db.prepare('SELECT * FROM wallet_stats').iterate() as Iterable<Record<string, any>>) {
    const w = walletFromRow(row);
    const next = classify(w, nowTs);
    if (next.join(',') !== w.archetypes.join(',')) changed.push([w.wallet, next]);
  }
  store.transaction(() => {
    for (const [wallet, archetypes] of changed) store.setArchetypes(wallet, archetypes);
    store.setMeta('classify_version', CLASSIFY_VERSION);
  });
  return changed.length;
}
