import type { DatabaseSync } from 'node:sqlite';
import { CURVE_FEE_RATE } from '../chain/curve.ts';
import { mean } from '../intel/reports.ts';
import { tweetTs, xHandle } from '../intel/xlinks.ts';
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
  /** 'yes' is a website that can be the narrative's source; 'promo' a promo, referral or trading-tool site. */
  website: 'yes' | 'promo' | 'no' | 'unknown';
  /** Launches of the same ticker by anyone in the 10 minutes before. */
  tickerWave: 'none' | '1-2' | '3+';
  /** How old the linked post was at launch (X post IDs carry their creation time). */
  postAge: PostAge;
  /** Whether another launch had already linked the same post. */
  postOrder: 'no post' | 'first' | 'later' | 'unknown';
  /** The dev's earlier launches the observer saw. */
  devHistory: 'first seen' | 'had a busy launch' | 'all dead';
  /** Launches linking a post by the same X account in the hour before: accounts farmed by many devs draw less. */
  sourceHeat: 'no post' | '0-2' | '3+' | 'unknown';
  /** Time since the dev's previous launch: snipers put less into a dev launching again within 10 minutes. */
  devGap: 'first seen' | 'under 10m' | '10m+';
  hourUtc: string;
}

/** Ticker launches this long before count as the same wave. */
export const WAVE_SEC = 600;

/**
 * Websites that are not a narrative's source: promo and referral pages and trading tools put on unrelated launches
 * (otcdesks.cash alone was on 217 launches on 2026-10-27).
 */
export const NOT_SOURCE_SITES = [
  'otcdesks.cash', 'axiom.trade', 'usepaid.app', 'launchdap.fun', 'coincommunities.org', 'pump.fun', 'dexscreener.com',
  'gmgn.ai', 'bullx.io', 't.me',
];

export function websiteKind(site: string | null): 'yes' | 'promo' | 'no' {
  const m = site?.trim().match(/(?:https?:\/\/)?([a-z0-9.-]+\.[a-z]{2,})/i);
  if (!m) return 'no';
  const host = m[1]!.toLowerCase().replace(/^www\./, '');
  return NOT_SOURCE_SITES.some((n) => host === n || host.endsWith(`.${n}`)) ? 'promo' : 'yes';
}

/** Post-age buckets and the oldest age (seconds) each holds. */
export const POST_AGE_MAX_SEC = { '<=30s': 30, '30s-2m': 120, '2-15m': 900, '>15m': Infinity } as const;
export type PostAge = keyof typeof POST_AGE_MAX_SEC | 'no post' | 'unknown';

export function postAgeBucket(ageSec: number | null): PostAge {
  if (ageSec === null) return 'no post';
  return (Object.keys(POST_AGE_MAX_SEC) as (keyof typeof POST_AGE_MAX_SEC)[]).find((k) => ageSec <= POST_AGE_MAX_SEC[k])!;
}

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

/**
 * Band of a launch buy (SOL paid, fees included), cut on the SOL that reaches the curve: sniper bots step in at about
 * 2.95 SOL, and round 3, 4 and 5 SOL buys are the presets of the busiest launch tools.
 */
export function devBuyBand(sol: number): string {
  const c = sol / (1 + CURVE_FEE_RATE);
  return c < 1 ? '<1' : c < 2.95 ? '1-2.95' : c < 3.05 ? '2.95-3.05' : c < 4.9 ? '3.05-4.9' : c < 5.1 ? '4.9-5.1' : '>=5.1';
}

export function xLinkKind(metaKnown: boolean, twitter: string | null): LaunchTraits['xLink'] {
  if (!metaKnown) return 'unknown';
  if (!twitter) return 'none';
  if (/\/status\//.test(twitter)) return 'tweet';
  if (/\/communities\//.test(twitter)) return 'community';
  return 'profile';
}

const normTicker = (s: string | null) => (s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** One key per X post, whatever form the link takes. */
const postKey = (link: string | null): string | null => {
  const at = tweetTs(link);
  return at === null ? null : `${xHandle(link) ?? ''}:${link!.match(/\/status(?:es)?\/(\d+)/)![1]}`;
};

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
  /** Launches linking a post by each X account, in time order. */
  const byAccount = new Map<string, number[]>();
  /** The first launch (in time order) to link each post. */
  const firstOnPost = new Map<string, string>();
  for (const l of launches) {
    const k = normTicker(l.symbol);
    if (k) byTicker.set(k, [...(byTicker.get(k) ?? []), l]);
    byDev.set(l.dev, [...(byDev.get(l.dev) ?? []), l]);
    const account = l.meta_status === 'done' && tweetTs(l.twitter) !== null ? xHandle(l.twitter) : null;
    if (account) byAccount.set(account, [...(byAccount.get(account) ?? []), l.ts]);
    const post = postKey(l.twitter);
    if (l.meta_status === 'done' && post && !firstOnPost.has(post)) firstOnPost.set(post, l.mint);
  }
  const out = new Map<string, LaunchTraits>();
  for (const c of coins) {
    const l = byMint.get(c.mint);
    const wave = (l ? (byTicker.get(normTicker(l.symbol)) ?? []) : []).filter(
      (x) => x.ts < c.createdTs && x.ts >= c.createdTs - WAVE_SEC,
    ).length;
    const metaKnown = l?.meta_status === 'done';
    const prior = (byDev.get(c.dev) ?? []).filter((x) => x.ts < c.createdTs);
    const account = metaKnown && tweetTs(l?.twitter ?? null) !== null ? xHandle(l?.twitter ?? null) : null;
    const heat = account ? (byAccount.get(account) ?? []).filter((x) => x < c.createdTs && x >= c.createdTs - 3600).length : 0;
    const postAt = metaKnown ? tweetTs(l?.twitter ?? null) : null;
    const post = metaKnown ? postKey(l?.twitter ?? null) : null;
    out.set(c.mint, {
      tool: launchTool(l?.uri ?? null),
      devBuy: devBuyBand(c.launchBuySol),
      xLink: xLinkKind(metaKnown, l?.twitter ?? null),
      website: !metaKnown ? 'unknown' : websiteKind(l?.website ?? null),
      tickerWave: wave === 0 ? 'none' : wave < 3 ? '1-2' : '3+',
      postAge: !metaKnown ? 'unknown' : postAgeBucket(postAt === null ? null : Math.max(0, c.createdTs - postAt)),
      postOrder: !metaKnown ? 'unknown' : post === null ? 'no post' : firstOnPost.get(post) === c.mint ? 'first' : 'later',
      devHistory: prior.length === 0 ? 'first seen' : prior.some((x) => x.busy) ? 'had a busy launch' : 'all dead',
      sourceHeat: !metaKnown ? 'unknown' : !account ? 'no post' : heat >= 3 ? '3+' : '0-2',
      devGap: prior.length === 0 ? 'first seen' : c.createdTs - prior.at(-1)!.ts < 600 ? 'under 10m' : '10m+',
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
