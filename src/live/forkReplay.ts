import type { Keypair } from '@solana/web3.js';
import type { PumpFork } from '../paper/fork.ts';
import { PHANTOM, type FlowTrade } from '../sim/flow.ts';
import { SLOT_SEC } from '../sim/simulate.ts';
import type { LiveTrade } from './types.ts';

/**
 * Replays a recorded launch's outside trades against our coin on the fork, in real time or sped up, the way the live
 * feed would deliver them, so the whole live loop (launch, exit manager, sell) runs end to end on pump.fun's real
 * program code. Each recorded wallet becomes a local wallet that buys the same SOL and sells the same share of what it
 * holds, as in the backtest (src/sim/simulate.ts). The recorded dev's trades are left out (we are the dev), and sells
 * that reacted to the recorded dev's sell wait until we have sold, then land right after.
 */

/** pump.fun coins have 6 decimals. */
const UNITS = 1e6;
const LAMPORTS = 1e9;

export interface ReplayOptions {
  /** 1 is real time; 10 replays ten times faster. */
  speed: number;
  /** The launch's chain time, for the trades' timestamps. */
  launchChainTs: number;
  onTrade: (t: LiveTrade) => void;
  /** Whether our whole-bag sell has landed: reaction sells wait for it. */
  sold: () => boolean;
  /** Stop replaying (the run is over). */
  stop: () => boolean;
  /** Seconds after launch to replay; later trades are dropped. */
  horizonSec?: number;
}

export interface ReplayStats {
  replayed: number;
  /** Sells by wallets that hold nothing here (routers, phantom fills, tokens passed in from elsewhere). */
  skippedSells: number;
  failed: number;
  errors: string[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

export async function replayOnFork(fork: PumpFork, mint: string, trades: FlowTrade[], o: ReplayOptions): Promise<ReplayStats> {
  const stats: ReplayStats = { replayed: 0, skippedSells: 0, failed: 0, errors: [] };
  if (!trades.length) return stats;
  const launchSlot = trades[0]!.slot;
  const wallets = new Map<number, Keypair>();
  /** Tokens each recorded wallet held on record, to sell the same share of its holding here. */
  const recordedHeld = new Map<number, number>();
  const deferred: FlowTrade[] = [];
  const start = Date.now();
  const horizon = o.horizonSec ?? 600;

  const run = async (t: FlowTrade) => {
    const key = t.wallet === PHANTOM ? null : t.wallet;
    let kp = key === null ? undefined : wallets.get(key);
    if (!kp) {
      kp = fork.wallet(Math.max(10, t.sol * 2));
      if (key !== null) wallets.set(key, kp);
    }
    try {
      if (t.isBuy) {
        const r = await fork.buy(kp, mint, t.sol);
        if (key !== null) recordedHeld.set(key, (recordedHeld.get(key) ?? 0) + t.tokens);
        emit(t, kp, r.curveSol + r.protocolFee + r.creatorFee, r.tokenDelta);
      } else {
        const held = fork.tokens(kp.publicKey, mint);
        const rec = key === null ? 0 : (recordedHeld.get(key) ?? 0);
        if (held <= 0n || rec <= 0) {
          stats.skippedSells++;
          return;
        }
        const share = Math.min(1, t.tokens / rec);
        recordedHeld.set(key!, rec - share * rec);
        const amount = share >= 0.999 ? held : BigInt(Math.floor(Number(held) * share));
        if (amount <= 0n) return;
        const r = await fork.sell(kp, mint, amount, { slippageBps: 10_000 });
        emit(t, kp, r.curveSol - r.protocolFee - r.creatorFee, -r.tokenDelta);
      }
      stats.replayed++;
    } catch (e) {
      stats.failed++;
      if (stats.errors.length < 5) stats.errors.push((e as Error).message.slice(0, 200));
    }
  };

  const emit = (t: FlowTrade, kp: Keypair, lamports: bigint, tokens: bigint) =>
    o.onTrade({
      slot: t.slot,
      chainTs: o.launchChainTs + Math.round((t.slot - launchSlot) * SLOT_SEC),
      receivedAt: Date.now(),
      wallet: kp.publicKey.toBase58(),
      isBuy: t.isBuy,
      sol: Number(lamports) / LAMPORTS,
      tokens: Number(tokens) / UNITS,
      dev: false,
    });

  for (const t of trades) {
    if (o.stop() || fork.curve(mint).complete) break;
    const age = (t.slot - launchSlot) * SLOT_SEC;
    if (age > horizon) break;
    if (t.dev) continue;
    await sleep(start + (age * 1000) / o.speed - Date.now());
    if (o.sold() && deferred.length) for (const d of deferred.splice(0)) await run(d);
    if (t.reaction && !o.sold()) {
      deferred.push(t);
      continue;
    }
    await run(t);
  }
  if (o.sold()) for (const d of deferred.splice(0)) await run(d);
  return stats;
}
