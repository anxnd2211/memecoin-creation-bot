import type { FlowTrade } from './flow.ts';

/**
 * Fake demand in the record: outside buying that is the dev's own. Selling into your own wallets is not profit, so
 * launches carrying it overstate what a single honest launch makes. Two kinds, found after the first live batch
 * (ml/coldstart.py, ml/followgate.py; 2026-10-29):
 *   - copy launches: the same metadata URI on more than one coin (one operator launching the same coin from many
 *     fresh wallets, often buying its own coins);
 *   - bundles: buys in the create slot from wallets that only ever buy one dev's coins there. No sniper reacting to a
 *     launch can be one dev's alone; wallets buying create slots across five or more devs are independent sniper bots,
 *     and their buying is real demand.
 * 47% of first launches on fresh posts were one or the other; without them a 2 SOL first launch made +0.61 SOL a
 * launch rather than +1.32, and drew buyers 33% of the time rather than 50%.
 */

export interface DemandCoin {
  mint: string;
  /** The dev's key (signer or creator): two coins with the same key are the same dev's. */
  dev: string;
  trades: Pick<FlowTrade, 'slot' | 'wallet' | 'isBuy' | 'sol' | 'dev'>[];
}

/** SOL of create-slot buying by one-dev wallets at which a launch counts as bundled. */
export const BUNDLE_MIN_SOL = 0.05;

/** For each wallet that bought in a create slot (not as the coin's dev), the devs whose create slots it bought. */
export function createSlotReach(coins: readonly DemandCoin[]): Map<number, Set<string>> {
  const reach = new Map<number, Set<string>>();
  for (const c of coins) {
    const s0 = c.trades[0]?.slot;
    for (const t of c.trades) {
      if (t.slot !== s0) break;
      if (t.dev || !t.isBuy) continue;
      const devs = reach.get(t.wallet) ?? new Set<string>();
      devs.add(c.dev);
      reach.set(t.wallet, devs);
    }
  }
  return reach;
}

/** Create-slot buying by wallets that only ever bought this dev's create slots: the dev's own bundle. */
export function bundledSol(c: DemandCoin, reach: ReadonlyMap<number, ReadonlySet<string>>): number {
  const s0 = c.trades[0]?.slot;
  let sol = 0;
  for (const t of c.trades) {
    if (t.slot !== s0) break;
    if (!t.dev && t.isBuy && reach.get(t.wallet)?.size === 1) sol += t.sol;
  }
  return sol;
}

/** Mints whose metadata URI another coin also uses. */
export function copiedMints(uris: Iterable<[mint: string, uri: string | null]>): Set<string> {
  const byUri = new Map<string, string[]>();
  for (const [mint, uri] of uris) if (uri) byUri.set(uri, [...(byUri.get(uri) ?? []), mint]);
  return new Set([...byUri.values()].filter((ms) => ms.length > 1).flat());
}

/** Whether a launch carried fake demand: a copy launch, or bundled. */
export function fakeDemand(c: DemandCoin, reach: ReadonlyMap<number, ReadonlySet<string>>, copied: ReadonlySet<string>): boolean {
  return copied.has(c.mint) || bundledSol(c, reach) >= BUNDLE_MIN_SOL;
}
