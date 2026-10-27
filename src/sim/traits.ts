import type { DatabaseSync } from 'node:sqlite';
import { mean } from '../intel/reports.ts';
import type { BacktestCoin } from './backtest.ts';

/**
 * Traits of a launch that are known when it is made, to compare against whether it drew buyers and what our plan
 * would have made on it. They describe other devs' launches; for ours, they are choices (dev buy, links, ticker) or
 * conditions (a live ticker wave, our wallet's history).
 */

export interface LaunchTraits {
  /** The tool that hosted the metadata: pump.fun's own site uploads to ipfs.io; launch terminals use their own hosts. */
  tool: string;
  devBuy: string;
  /** What the X link points to; unknown when the metadata could not be fetched. */
  xLink: 'tweet' | 'community' | 'profile' | 'none' | 'unknown';
  website: 'yes' | 'no' | 'unknown';
  /** Launches of the same ticker by anyone in the 10 minutes before. */
  tickerWave: 'none' | '1-2' | '3+';
  /** The dev's earlier launches the observer saw. */
  devHistory: 'first seen' | 'had a busy launch' | 'all dead';
  hourUtc: string;
}

/** Ticker launches this long before count as the same wave. */
export const WAVE_SEC = 600;

const TOOLS: [string, string][] = [
  ['j7tracker', 'j7tracker'],
  ['uxento', 'uxento'],
  ['rapidlaunch', 'rapidlaunch'],
  ['vercel-storage', 'vercel-blob'],
  ['pinata', 'pinata'],
];

export function launchTool(uri: string | null): string {
  const u = uri ?? '';
  if (u.startsWith('https://ipfs.io/')) return 'ipfs.io';
  return TOOLS.find(([needle]) => u.includes(needle))?.[1] ?? 'other';
}

export function devBuyBand(sol: number): string {
  return sol < 1 ? '<1' : sol < 2.95 ? '1-2.95' : sol < 4.5 ? '2.95-4.5' : '>=4.5';
}

export function xLinkKind(metaKnown: boolean, twitter: string | null): LaunchTraits['xLink'] {
  if (!metaKnown) return 'unknown';
  if (!twitter) return 'none';
  if (/\/status\//.test(twitter)) return 'tweet';
  if (/\/communities\//.test(twitter)) return 'community';
  return 'profile';
}

const normTicker = (s: string | null) => (s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

interface LaunchRow {
  mint: string;
  symbol: string | null;
  uri: string | null;
  ts: number;
  dev: string;
  busy: number;
  meta_status: string;
  twitter: string | null;
  website: string | null;
}

/** Traits for each coin, from every SOL launch the observer saw since `sinceTs` (Mayhem included, for waves). */
export function launchTraits(db: DatabaseSync, coins: BacktestCoin[], sinceTs: number): Map<string, LaunchTraits> {
  const launches = db
    .prepare(
      `SELECT mint, symbol, uri, created_ts AS ts, COALESCE(launcher, creator) AS dev,
         unique_buyers - early_buyers >= 10 AS busy, meta_status, twitter, website
       FROM coins WHERE created_ts >= ? AND quote = 'SOL' ORDER BY created_ts`,
    )
    .all(sinceTs) as unknown as LaunchRow[];
  const byMint = new Map(launches.map((l) => [l.mint, l]));
  const byTicker = new Map<string, LaunchRow[]>();
  const byDev = new Map<string, LaunchRow[]>();
  for (const l of launches) {
    const k = normTicker(l.symbol);
    if (k) byTicker.set(k, [...(byTicker.get(k) ?? []), l]);
    byDev.set(l.dev, [...(byDev.get(l.dev) ?? []), l]);
  }
  const out = new Map<string, LaunchTraits>();
  for (const c of coins) {
    const l = byMint.get(c.mint);
    const wave = (l ? (byTicker.get(normTicker(l.symbol)) ?? []) : []).filter(
      (x) => x.ts < c.createdTs && x.ts >= c.createdTs - WAVE_SEC,
    ).length;
    const prior = (byDev.get(c.dev) ?? []).filter((x) => x.ts < c.createdTs);
    const metaKnown = l?.meta_status === 'done';
    out.set(c.mint, {
      tool: launchTool(l?.uri ?? null),
      devBuy: devBuyBand(c.launchBuySol),
      xLink: xLinkKind(metaKnown, l?.twitter ?? null),
      website: !metaKnown ? 'unknown' : l?.website ? 'yes' : 'no',
      tickerWave: wave === 0 ? 'none' : wave < 3 ? '1-2' : '3+',
      devHistory: prior.length === 0 ? 'first seen' : prior.some((x) => x.busy) ? 'had a busy launch' : 'all dead',
      hourUtc: String(new Date(c.createdTs * 1000).getUTCHours()).padStart(2, '0'),
    });
  }
  return out;
}

export interface TraitRow {
  trait: keyof LaunchTraits;
  value: string;
  launches: number;
  busyShare: number | null;
  meanPnl: number | null;
  /** The same on the earlier and later half of the launches, to see whether it holds up. */
  firstHalf: { launches: number; busyShare: number | null; meanPnl: number | null };
  secondHalf: { launches: number; busyShare: number | null; meanPnl: number | null };
}

/** Busy share and mean result per value of each trait; `coins` in time order, `pnls` from one plan. */
export function traitTable(coins: BacktestCoin[], pnls: number[], traits: Map<string, LaunchTraits>): TraitRow[] {
  const half = Math.floor(coins.length / 2);
  const summary = (idx: number[]) => ({
    launches: idx.length,
    busyShare: mean(idx.map((i) => (coins[i]!.active ? 1 : 0))),
    meanPnl: mean(idx.map((i) => pnls[i]!)),
  });
  const rows: TraitRow[] = [];
  const keys = Object.keys(traits.values().next().value ?? {}) as (keyof LaunchTraits)[];
  for (const trait of keys) {
    const values = [...new Set(coins.map((c) => traits.get(c.mint)![trait]))].sort();
    for (const value of values) {
      const idx = coins.map((_, i) => i).filter((i) => traits.get(coins[i]!.mint)![trait] === value);
      rows.push({
        trait,
        value,
        ...summary(idx),
        firstHalf: summary(idx.filter((i) => i < half)),
        secondHalf: summary(idx.filter((i) => i >= half)),
      });
    }
  }
  return rows;
}
