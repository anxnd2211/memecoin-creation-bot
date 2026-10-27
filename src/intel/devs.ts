import type { DatabaseSync } from 'node:sqlite';
import { CURVE_MAX_PRICE_SOL, STANDARD_LAUNCH_MCAP_SOL, curveSellValue } from '../chain/curve.ts';
import { MAYHEM_AGENT } from '../chain/programs.ts';
import { SNIPE_WINDOW_SEC } from './classify.ts';
import { isBuyout, mean, median, share } from './reports.ts';

/**
 * Dev screening: for every launch, what its creator spent, took out and earned in fees, when and into what the
 * creator sold, and whether other wallets moved with the creator. Built from stored curve trades, so trading after
 * graduation (on PumpSwap) is not included.
 */

/** Creator fee share of curve volume, used for coins launched before fees were recorded. */
export const ESTIMATED_CREATOR_FEE_RATE = 0.003;
/** Two wallets acting within this many slots (about a second) of each other count as acting together. */
export const COORDINATION_SLOTS = 3;
/**
 * A wallet that bought in the launch window of this many different devs' coins, or bought this many coins in all, is
 * a sniper bot rather than one dev's own wallet; it is not counted as moving with the dev.
 */
export const SNIPER_MIN_DEVS = 3;
export const SNIPER_MIN_COINS = 10;
/** A coin had trading activity when this many wallets other than the creator and launch-second buyers bought. */
export const ACTIVE_MIN_BUYERS = 10;
/** ...and those wallets bought at least this much SOL in total. */
export const ACTIVE_MIN_BUY_SOL = 1;
/** Seconds after launch at which the trade-flow buckets end. */
export const FLOW_BUCKETS = [3, 10, 30, 60, 120, 300, 900, 3600] as const;


export interface TradeRow {
  ts: number;
  slot: number;
  wallet: number;
  isBuy: boolean;
  sol: number;
  coins: number;
  mcap: number | null;
}

export interface CoinInfo {
  mint: string;
  symbol: string | null;
  name: string | null;
  creator: string;
  /** Wallet that signed the launch, when known. */
  launcher: string | null;
  createdTs: number;
  launchMcapSol: number | null;
  lastPriceSol: number | null;
  peakMcapSol: number;
  peakTs: number | null;
  graduatedTs: number | null;
  volumeSol: number;
  /** Launched in Mayhem mode, so pump.fun's agent may trade it for 24 hours. */
  isMayhem: boolean;
  /** Measured creator fees, or null when the coin predates fee capture. */
  creatorFeesSol: number | null;
  socials: { twitter: boolean; telegram: boolean; website: boolean } | null;
}

export type SellStyle = 'no_buy' | 'holding' | 'single_dump' | 'tranches' | 'partial';

/** Market state just before the creator's first sell. */
export interface FirstSell {
  ageSec: number;
  /** Wallets other than the creator that had bought. */
  buyersBefore: number;
  buySolBefore: number;
  sellSolBefore: number;
  /** Market cap before the sell over market cap at launch. */
  mcapMultiple: number | null;
  /** Market cap before the sell over the coin's peak: 1 means the creator sold at the top. */
  shareOfPeak: number | null;
  buySolLast10s: number;
  /** Seconds since the last buy by another wallet; small values mean the creator sold into a buy. */
  sinceLastBuySec: number | null;
  /** Share of the creator's tokens sold in this first sell. */
  soldShare: number;
}

export interface DevCoin {
  info: CoinInfo;
  devBuySol: number;
  devSellSol: number;
  devBuys: number;
  devSells: number;
  /** What the dev's unsold tokens would return if sold into the curve now; 0 for graduated coins. */
  devBagSol: number;
  /** Unsold tokens on a graduated coin at the last price; left out of the result since pool depth is unknown. */
  devGraduatedBagSol: number;
  devTradingPnl: number;
  feesSol: number;
  feesEstimated: boolean;
  devTotalPnl: number;
  style: SellStyle;
  firstSell: FirstSell | null;
  lastSellAgeSec: number | null;
  /** Wallets other than the creator and launch-second buyers. */
  organicBuyers: number;
  organicBuySol: number;
  /** Other wallets, not known sniper bots, whose first buy landed in the creator's launch slot. */
  sameSlotBuyers: number;
  /** Other wallets whose first buy landed within the launch window. */
  earlyBuyers: number;
  /** Launch-window buyers, not known sniper bots, that sold within COORDINATION_SLOTS of a creator sell. */
  coordinatedSellers: number;
  /**
   * Accounts that sold more tokens than they bought on the curve. Mostly trading routers (the event names the router's
   * account, not the trader) and the Mayhem agent's extra supply; dev wallets passing tokens on are a minority.
   */
  transferSellers: number;
  /** SOL those accounts took out for tokens with no recorded buy. */
  transferSellSol: number;
  /** pump.fun's Mayhem agent: SOL it spent before the dev's first sell, and its net SOL on the coin. */
  agentBuySolBeforeSell: number;
  agentNetSol: number;
  /** Dev result plus the wallets in the same slot or selling with the dev. */
  clusterPnl: number;
  bundleLike: boolean;
  /**
   * The dev sold over 1% more tokens than it bought on the curve: other wallets bought them and passed them to the
   * dev to sell, a bundle the slot tests do not catch.
   */
  devSoldUnbought: boolean;
  active: boolean;
  /** Per-bucket flow; index i covers ages up to FLOW_BUCKETS[i]. */
  flow: { buys: number; sells: number; buySol: number; sellSol: number; newBuyers: number }[];
  /** Other wallets' buy SOL in the minute before and after the creator's first sell. */
  aroundFirstSell: { before: number; after: number } | null;
  peakAfterFirstSell: boolean | null;
  /** Each other wallet's first-buy age, buy SOL and result, for composition stats. */
  wallets: { wallet: number; firstBuyAge: number | null; buySol: number; pnl: number; firstSellAge: number | null }[];
}

interface WalletAcc {
  buySol: number;
  sellSol: number;
  bought: number;
  sold: number;
  firstBuyTs: number | null;
  firstBuySlot: number | null;
  firstSellTs: number | null;
  firstSellSlot: number | null;
}

/** Value of unsold tokens: curve liquidation where the curve is standard, else the last price. */
function bagValue(info: CoinInfo, tokens: number): number {
  const price = info.lastPriceSol ?? 0;
  const standard =
    info.graduatedTs === null &&
    info.launchMcapSol !== null &&
    Math.abs(info.launchMcapSol - STANDARD_LAUNCH_MCAP_SOL) < 0.01 * STANDARD_LAUNCH_MCAP_SOL;
  return standard ? curveSellValue(price, tokens) : tokens * price;
}

const newAcc = (): WalletAcc => ({
  buySol: 0,
  sellSol: 0,
  bought: 0,
  sold: 0,
  firstBuyTs: null,
  firstBuySlot: null,
  firstSellTs: null,
  firstSellSlot: null,
});

/**
 * Screens one coin from its ordered curve trades. The dev is every wallet in `devIds`: the creator and, when it
 * differs, the wallet that signed the launch.
 */
export function analyseCoin(
  info: CoinInfo,
  trades: TradeRow[],
  devIds: ReadonlySet<number>,
  agentIds: ReadonlySet<number> = new Set(),
  snipers: ReadonlySet<number> = new Set(),
): DevCoin {
  const created = info.createdTs;
  const dev = newAcc();
  const acc = new Map<number, WalletAcc>();
  const devSellSlots: number[] = [];
  let launchSlot: number | null = null;
  const flow = FLOW_BUCKETS.map(() => ({ buys: 0, sells: 0, buySol: 0, sellSol: 0, newBuyers: 0 }));
  let firstSell: FirstSell | null = null;
  let firstSellTs: number | null = null;
  let lastSellTs: number | null = null;
  let buySolBefore = 0;
  let sellSolBefore = 0;
  const buyersBefore = new Set<number>();
  let lastMcap: number | null = info.launchMcapSol;
  let lastOtherBuyTs: number | null = null;
  let agentBuySolBeforeSell = 0;

  for (const t of trades) {
    const age = t.ts - created;
    const isDev = devIds.has(t.wallet);
    let a = isDev ? dev : acc.get(t.wallet);
    if (!a) {
      a = newAcc();
      acc.set(t.wallet, a);
    }
    if (isDev && t.isBuy && launchSlot === null && age <= 1) launchSlot = t.slot;
    if (launchSlot === null && age <= 0) launchSlot = t.slot;

    const bucket = FLOW_BUCKETS.findIndex((b) => age <= b);
    if (bucket >= 0 && !isDev) {
      const f = flow[bucket]!;
      if (t.isBuy) {
        f.buys++;
        f.buySol += t.sol;
        if (a.firstBuyTs === null) f.newBuyers++;
      } else {
        f.sells++;
        f.sellSol += t.sol;
      }
    }

    if (isDev && !t.isBuy) {
      devSellSlots.push(t.slot);
      lastSellTs = t.ts;
      if (firstSell === null) {
        const devBought = a.bought;
        const recent = trades.filter((x) => !devIds.has(x.wallet) && x.isBuy && x.ts <= t.ts && x.ts > t.ts - 10);
        firstSellTs = t.ts;
        firstSell = {
          ageSec: age,
          buyersBefore: buyersBefore.size,
          buySolBefore,
          sellSolBefore,
          mcapMultiple: lastMcap !== null && info.launchMcapSol ? lastMcap / info.launchMcapSol : null,
          shareOfPeak: lastMcap !== null && info.peakMcapSol > 0 ? Math.min(1, lastMcap / info.peakMcapSol) : null,
          buySolLast10s: recent.reduce((s, x) => s + x.sol, 0),
          sinceLastBuySec: lastOtherBuyTs !== null ? t.ts - lastOtherBuyTs : null,
          soldShare: devBought > 0 ? Math.min(1, t.coins / devBought) : 1,
        };
      }
    }

    if (t.isBuy) {
      a.buySol += t.sol;
      a.bought += t.coins;
      if (a.firstBuyTs === null) {
        a.firstBuyTs = t.ts;
        a.firstBuySlot = t.slot;
      }
      if (!isDev) {
        lastOtherBuyTs = t.ts;
        if (firstSellTs === null && agentIds.has(t.wallet)) agentBuySolBeforeSell += t.sol;
        if (firstSellTs === null) {
          buySolBefore += t.sol;
          buyersBefore.add(t.wallet);
        }
      }
    } else {
      a.sellSol += t.sol;
      a.sold += t.coins;
      if (a.firstSellTs === null) {
        a.firstSellTs = t.ts;
        a.firstSellSlot = t.slot;
      }
      if (!isDev && firstSellTs === null) sellSolBefore += t.sol;
    }
    if (t.mcap !== null) lastMcap = t.mcap;
  }

  // Unsold tokens per wallet can add up to more than is outstanding when tokens moved between accounts (a router
  // buys for a trader who later sells directly): the buyer still looks like it holds them while the seller sells
  // them. Shrink every holding pro rata to what is left. The Mayhem agent sells extra supply minted to it, so it
  // is left out.
  const all = [dev, ...[...acc].filter(([w]) => !agentIds.has(w)).map(([, a]) => a)];
  const outstanding = Math.max(0, all.reduce((s, a) => s + a.bought - a.sold, 0));
  const held = all.reduce((s, a) => s + Math.max(0, a.bought - a.sold), 0);
  const heldScale = held > outstanding && held > 0 ? outstanding / held : 1;

  const { buySol: devBuySol, sellSol: devSellSol, bought: devBought, sold: devSold } = dev;
  const devLeft = Math.max(0, devBought - devSold) * heldScale;
  const graduated = info.graduatedTs !== null;
  const devBagSol = graduated ? 0 : bagValue(info, devLeft);
  const devGraduatedBagSol = graduated ? devLeft * (info.lastPriceSol ?? 0) : 0;
  const devTradingPnl = devSellSol - devBuySol + devBagSol;
  const feesEstimated = info.creatorFeesSol === null;
  const feesSol = info.creatorFeesSol ?? info.volumeSol * ESTIMATED_CREATOR_FEE_RATE;
  const devBuys = trades.filter((t) => devIds.has(t.wallet) && t.isBuy).length;
  const devSells = devSellSlots.length;

  let style: SellStyle;
  if (devBought === 0) style = 'no_buy';
  else if (devSells === 0) style = 'holding';
  else if (devSold < devBought * 0.9) style = 'partial';
  else if (devSells === 1 || (firstSell?.soldShare ?? 0) >= 0.9) style = 'single_dump';
  else style = 'tranches';

  const wallets: DevCoin['wallets'] = [];
  let organicBuyers = 0;
  let organicBuySol = 0;
  let sameSlotBuyers = 0;
  let earlyBuyers = 0;
  let coordinatedSellers = 0;
  let transferSellers = 0;
  let transferSellSol = 0;
  let agentNetSol = 0;
  let clusterPnl = devTradingPnl;
  for (const [wallet, a] of acc) {
    const pnl = a.sellSol - a.buySol + bagValue(info, Math.max(0, a.bought - a.sold) * heldScale);
    if (agentIds.has(wallet)) {
      agentNetSol += a.sellSol - a.buySol;
      continue;
    }
    const unbought = a.sold - a.bought;
    if (unbought > 0.01 * Math.max(a.sold, 1)) {
      transferSellers++;
      transferSellSol += (a.sellSol * unbought) / a.sold;
    }
    const firstBuyAge = a.firstBuyTs !== null ? a.firstBuyTs - created : null;
    wallets.push({ wallet, firstBuyAge, buySol: a.buySol, pnl, firstSellAge: a.firstSellTs !== null ? a.firstSellTs - created : null });
    if (firstBuyAge === null) continue;
    const early = firstBuyAge <= SNIPE_WINDOW_SEC;
    const sameSlot = launchSlot !== null && a.firstBuySlot === launchSlot && !snipers.has(wallet);
    const sellsWithDev =
      early &&
      !snipers.has(wallet) &&
      a.firstSellSlot !== null &&
      devSellSlots.some((s) => Math.abs(s - a.firstSellSlot!) <= COORDINATION_SLOTS);
    if (early) earlyBuyers++;
    else {
      organicBuyers++;
      organicBuySol += a.buySol;
    }
    if (sameSlot) sameSlotBuyers++;
    if (sellsWithDev) coordinatedSellers++;
    if (sameSlot || sellsWithDev) clusterPnl += pnl;
  }

  let aroundFirstSell: DevCoin['aroundFirstSell'] = null;
  if (firstSellTs !== null) {
    const ts = firstSellTs;
    const other = trades.filter((t) => !devIds.has(t.wallet) && t.isBuy);
    aroundFirstSell = {
      before: other.filter((t) => t.ts >= ts - 60 && t.ts < ts).reduce((s, t) => s + t.sol, 0),
      after: other.filter((t) => t.ts > ts && t.ts <= ts + 60).reduce((s, t) => s + t.sol, 0),
    };
  }

  return {
    info,
    devBuySol,
    devSellSol,
    devBuys,
    devSells,
    devBagSol,
    devGraduatedBagSol,
    devTradingPnl,
    feesSol,
    feesEstimated,
    devTotalPnl: devTradingPnl + feesSol,
    style,
    firstSell,
    lastSellAgeSec: lastSellTs !== null ? lastSellTs - created : null,
    organicBuyers,
    organicBuySol,
    sameSlotBuyers,
    earlyBuyers,
    coordinatedSellers,
    transferSellers,
    transferSellSol,
    agentBuySolBeforeSell,
    agentNetSol,
    clusterPnl: clusterPnl + feesSol,
    bundleLike: sameSlotBuyers >= 2 || coordinatedSellers >= 2,
    devSoldUnbought: devSold > devBought * 1.01,
    active: organicBuyers >= ACTIVE_MIN_BUYERS && organicBuySol >= ACTIVE_MIN_BUY_SOL,
    flow,
    aroundFirstSell,
    peakAfterFirstSell: firstSellTs !== null && info.peakTs !== null ? info.peakTs > firstSellTs : null,
    wallets,
  };
}

// ---- Database access ----

interface CoinDbRow {
  mint: string;
  symbol: string | null;
  name: string | null;
  creator: string;
  launcher: string | null;
  created_ts: number;
  launch_price_sol: number | null;
  total_supply: number;
  last_price_sol: number | null;
  peak_mcap_sol: number;
  peak_ts: number | null;
  graduated_ts: number | null;
  pool: string | null;
  is_mayhem: number;
  volume_sol: number;
  creator_fees_sol: number;
  meta_status: string;
  twitter: string | null;
  telegram: string | null;
  website: string | null;
  mint_id: number | null;
  creator_id: number | null;
  launcher_id: number | null;
}

/** A launch with its ordered curve trades, ready to screen or replay. */
export interface LoadedLaunch {
  info: CoinInfo;
  trades: TradeRow[];
  /** The creator and, when it differs, the wallet that signed the launch. */
  devIds: Set<number>;
}

/**
 * Loads SOL-quoted launches created in [sinceTs, untilTs], skipping launch buyouts. With `recordedLive`, only coins
 * whose launching wallet and creator fees the observer recorded itself. Also returns pump.fun's Mayhem agent and the
 * sniper bots seen across these launches.
 */
export function loadLaunches(
  db: DatabaseSync,
  sinceTs: number,
  untilTs: number,
  recordedLive = false,
): { launches: LoadedLaunch[]; agentIds: Set<number>; snipers: Set<number> } {
  const feesSince = Number(
    (db.prepare("SELECT value FROM meta WHERE key = 'creator_fees_since'").get() as { value: string } | undefined)?.value ??
      Infinity,
  );
  const coins = db
    .prepare(
      `SELECT x.*, m.id AS mint_id, cr.id AS creator_id, la.id AS launcher_id FROM (
         SELECT c.mint, c.symbol, c.name, c.creator, COALESCE(c.launcher, l.launcher) AS launcher, c.created_ts,
           c.launch_price_sol, c.total_supply, c.last_price_sol, c.peak_mcap_sol, c.peak_ts, c.graduated_ts, c.pool, c.is_mayhem, c.volume_sol,
           c.creator_fees_sol, c.meta_status, c.twitter, c.telegram, c.website
         FROM coins c LEFT JOIN launchers l ON l.mint = c.mint
         WHERE c.created_ts BETWEEN ? AND ? AND c.quote = 'SOL' AND c.creator IS NOT NULL
           AND (? = 0 OR (c.launcher IS NOT NULL AND c.created_ts >= ?))) x
       LEFT JOIN ids m ON m.address = x.mint LEFT JOIN ids cr ON cr.address = x.creator
       LEFT JOIN ids la ON la.address = x.launcher`,
    )
    .all(sinceTs, untilTs, recordedLive ? 1 : 0, Number.isFinite(feesSince) ? feesSince : 0) as unknown as CoinDbRow[];
  const agentId = (db.prepare('SELECT id FROM ids WHERE address = ?').get(MAYHEM_AGENT) as { id: number } | undefined)?.id;
  const agentIds = new Set(agentId !== undefined ? [agentId] : []);
  const tradeQuery = db.prepare(
    'SELECT ts, slot, wallet_id, is_buy, sol, coins, mcap_sol FROM trades WHERE mint_id = ? ORDER BY ts, slot, rowid',
  );
  const launches: LoadedLaunch[] = coins
    .filter((c) => !isBuyout(c) && c.mint_id !== null)
    .map((c) => {
      const rows = tradeQuery.all(c.mint_id) as { ts: number; slot: number; wallet_id: number; is_buy: number; sol: number | null; coins: number; mcap_sol: number | null }[];
      const trades: TradeRow[] = rows
        .filter((r) => r.sol !== null)
        .map((r) => ({ ts: r.ts, slot: r.slot, wallet: r.wallet_id, isBuy: r.is_buy === 1, sol: r.sol!, coins: r.coins, mcap: r.mcap_sol }));
      const devIds = new Set([c.creator_id, c.launcher_id].filter((id): id is number => id !== null));
      const metaKnown = c.meta_status === 'done';
      const info: CoinInfo = {
        mint: c.mint,
        symbol: c.symbol,
        name: c.name,
        creator: c.creator,
        launcher: c.launcher,
        createdTs: c.created_ts,
        launchMcapSol: c.launch_price_sol !== null ? c.launch_price_sol * c.total_supply : null,
        lastPriceSol: c.last_price_sol,
        peakMcapSol: c.peak_mcap_sol,
        peakTs: c.peak_ts,
        // A graduation missed during a feed gap still shows as a pool or a price the curve cannot reach.
        graduatedTs:
          c.graduated_ts ??
          (c.pool !== null || (c.last_price_sol ?? 0) > CURVE_MAX_PRICE_SOL * 1.01 ? (c.peak_ts ?? c.created_ts) : null),
        volumeSol: c.volume_sol,
        isMayhem: c.is_mayhem === 1,
        creatorFeesSol: c.created_ts >= feesSince ? c.creator_fees_sol : null,
        socials: metaKnown ? { twitter: !!c.twitter, telegram: !!c.telegram, website: !!c.website } : null,
      };
      return { info, trades, devIds };
    });

  // Sniper bots: wallets in the launch window of several devs' coins, or buying many coins.
  const windowDevs = new Map<number, Set<string>>();
  const coinsBought = new Map<number, number>();
  for (const { info, trades, devIds } of launches) {
    const seen = new Set<number>();
    for (const t of trades) {
      if (!t.isBuy || devIds.has(t.wallet) || seen.has(t.wallet)) continue;
      seen.add(t.wallet);
      coinsBought.set(t.wallet, (coinsBought.get(t.wallet) ?? 0) + 1);
      if (t.ts - info.createdTs <= SNIPE_WINDOW_SEC) {
        windowDevs.set(t.wallet, (windowDevs.get(t.wallet) ?? new Set()).add(info.launcher ?? info.creator));
      }
    }
  }
  const snipers = new Set<number>();
  for (const [w, devs] of windowDevs) {
    if (devs.size >= SNIPER_MIN_DEVS || (coinsBought.get(w) ?? 0) >= SNIPER_MIN_COINS) snipers.add(w);
  }
  return { launches, agentIds, snipers };
}

/** Screens the launches `loadLaunches` returns; see there for the arguments. */
export function screenLaunches(db: DatabaseSync, sinceTs: number, untilTs: number, recordedLive = false): DevCoin[] {
  const { launches, agentIds, snipers } = loadLaunches(db, sinceTs, untilTs, recordedLive);
  return launches.map((l) => analyseCoin(l.info, l.trades, l.devIds, agentIds, snipers));
}

/** Wallet id -> archetype labels, for wallets that have any. */
export function archetypesById(db: DatabaseSync): Map<number, string[]> {
  const rows = db
    .prepare("SELECT i.id, w.archetypes FROM wallet_stats w JOIN ids i ON i.address = w.wallet WHERE w.archetypes != ''")
    .all() as { id: number; archetypes: string }[];
  return new Map(rows.map((r) => [r.id, r.archetypes.split(',')]));
}

// ---- Aggregates ----

const q = (xs: number[], p: number): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
};
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

function profile(coins: DevCoin[]) {
  const sold = coins.filter((c) => c.firstSell);
  const launcherKnown = coins.filter((c) => c.info.launcher !== null);
  const withMeta = coins.filter((c) => c.info.socials);
  return {
    coins: coins.length,
    devProfitableShare: share(coins.map((c) => c.devTotalPnl > 0)),
    medianDevPnl: median(coins.map((c) => c.devTotalPnl)),
    meanDevPnl: mean(coins.map((c) => c.devTotalPnl)),
    totalDevPnl: sum(coins.map((c) => c.devTotalPnl)),
    totalFees: sum(coins.map((c) => c.feesSol)),
    medianDevBuySol: median(coins.filter((c) => c.devBuySol > 0).map((c) => c.devBuySol)),
    noDevBuyShare: share(coins.map((c) => c.style === 'no_buy')),
    medianFirstSellSec: median(sold.map((c) => c.firstSell!.ageSec)),
    medianBuyersBeforeSell: median(sold.map((c) => c.firstSell!.buyersBefore)),
    medianBuySolBeforeSell: median(sold.map((c) => c.firstSell!.buySolBefore)),
    medianMcapMultipleAtSell: median(sold.flatMap((c) => (c.firstSell!.mcapMultiple !== null ? [c.firstSell!.mcapMultiple] : []))),
    medianShareOfPeakAtSell: median(sold.flatMap((c) => (c.firstSell!.shareOfPeak !== null ? [c.firstSell!.shareOfPeak] : []))),
    medianOrganicBuyers: median(coins.map((c) => c.organicBuyers)),
    medianOrganicBuySol: median(coins.map((c) => c.organicBuySol)),
    bundleLikeShare: share(coins.map((c) => c.bundleLike)),
    devSoldUnboughtShare: share(coins.map((c) => c.devSoldUnbought)),
    tokensMovedShare: share(coins.map((c) => c.transferSellSol >= 0.1)),
    mayhemShare: share(coins.map((c) => c.info.isMayhem)),
    medianAgentSolBeforeSell: median(coins.filter((c) => c.info.isMayhem && c.firstSell).map((c) => c.agentBuySolBeforeSell)),
    agentNetSol: sum(coins.map((c) => c.agentNetSol)),
    socialsShare: share(withMeta.map((c) => !!(c.info.socials!.twitter || c.info.socials!.telegram || c.info.socials!.website))),
    twitterShare: share(withMeta.map((c) => c.info.socials!.twitter)),
    metadataKnown: withMeta.length,
    graduatedShare: share(coins.map((c) => c.info.graduatedTs !== null)),
    launcherNotCreatorShare: share(launcherKnown.map((c) => c.info.launcher !== c.info.creator)),
  };
}

/**
 * The way this project launches: one wallet that is both creator and signer, no wallets buying in the launch slot or
 * selling alongside it, and no tokens passed to the dev by other wallets to sell.
 */
export function isSingleWalletClean(c: DevCoin): boolean {
  return !c.bundleLike && !c.devSoldUnbought && (c.info.launcher === null || c.info.launcher === c.info.creator);
}

/** Sell style, first-sell timing and pre-sell inflow against the dev's result, for one group of coins. */
function exitBreakdown(coins: DevCoin[]) {
  const styles = (['single_dump', 'tranches', 'partial', 'holding', 'no_buy'] as SellStyle[]).map((style) => {
    const xs = coins.filter((c) => c.style === style);
    return {
      style,
      coins: xs.length,
      profitableShare: share(xs.map((c) => c.devTotalPnl > 0)),
      medianDevPnl: median(xs.map((c) => c.devTotalPnl)),
      medianOrganicBuyers: median(xs.map((c) => c.organicBuyers)),
      graduated: xs.filter((c) => c.info.graduatedTs !== null).length,
    };
  });

  // When the first sell came, against what the dev made.
  const sold = coins.filter((c) => c.firstSell);
  const timing = [
    ['<=10s', 0, 10],
    ['11-30s', 11, 30],
    ['31-60s', 31, 60],
    ['1-3m', 61, 180],
    ['3-10m', 181, 600],
    ['>10m', 601, Infinity],
  ].map(([label, lo, hi]) => {
    const xs = sold.filter((c) => c.firstSell!.ageSec >= (lo as number) && c.firstSell!.ageSec <= (hi as number));
    return {
      firstSell: label as string,
      coins: xs.length,
      profitableShare: share(xs.map((c) => c.devTotalPnl > 0)),
      medianDevPnl: median(xs.map((c) => c.devTotalPnl)),
      medianBuySolBefore: median(xs.map((c) => c.firstSell!.buySolBefore)),
      medianOrganicBuyers: median(xs.map((c) => c.organicBuyers)),
      peakAfterSellShare: share(xs.map((c) => c.peakAfterFirstSell === true)),
    };
  });

  // Net SOL other wallets had put in before the dev sold, against the result.
  const inflow = [
    ['<0.5 SOL', -Infinity, 0.5],
    ['0.5-2', 0.5, 2],
    ['2-5', 2, 5],
    ['5-15', 5, 15],
    ['>=15', 15, Infinity],
  ].map(([label, lo, hi]) => {
    const xs = sold.filter((c) => {
      const net = c.firstSell!.buySolBefore - c.firstSell!.sellSolBefore;
      return net >= (lo as number) && net < (hi as number);
    });
    return {
      netInflowBeforeSell: label as string,
      coins: xs.length,
      profitableShare: share(xs.map((c) => c.devTotalPnl > 0)),
      medianDevPnl: median(xs.map((c) => c.devTotalPnl)),
      medianDevBuySol: median(xs.map((c) => c.devBuySol)),
      medianResultPerDevBuy: median(xs.filter((c) => c.devBuySol > 0).map((c) => c.devTotalPnl / c.devBuySol)),
    };
  });
  return { styles, timing, inflow };
}

export function devScreenReport(coins: DevCoin[], archetypes: Map<number, string[]>, limit: number) {
  const active = coins.filter((c) => c.active);
  const profitable = active.filter((c) => c.devTotalPnl > 0);
  const losing = active.filter((c) => c.devTotalPnl <= 0);
  const clean = active.filter(isSingleWalletClean);
  const bundled = active.filter((c) => !isSingleWalletClean(c));

  // Creators: every launch counts, including the ones nobody traded.
  const byCreator = new Map<string, DevCoin[]>();
  for (const c of coins) {
    const key = c.info.launcher ?? c.info.creator;
    const list = byCreator.get(key) ?? [];
    list.push(c);
    byCreator.set(key, list);
  }
  const creators = [...byCreator.entries()]
    .map(([creator, xs]) => {
      xs.sort((a, b) => a.info.createdTs - b.info.createdTs);
      const gaps = xs.slice(1).map((c, i) => c.info.createdTs - xs[i]!.info.createdTs);
      const styleCounts = new Map<string, number>();
      for (const c of xs) styleCounts.set(c.style, (styleCounts.get(c.style) ?? 0) + 1);
      return {
        creator,
        launches: xs.length,
        active: xs.filter((c) => c.active).length,
        profitable: xs.filter((c) => c.devTotalPnl > 0).length,
        totalPnl: sum(xs.map((c) => c.devTotalPnl)),
        clusterPnl: sum(xs.map((c) => c.clusterPnl)),
        fees: sum(xs.map((c) => c.feesSol)),
        medianDevBuySol: median(xs.map((c) => c.devBuySol)),
        medianFirstSellSec: median(xs.flatMap((c) => (c.firstSell ? [c.firstSell.ageSec] : []))),
        medianGapSec: median(gaps),
        mainStyle: [...styleCounts.entries()].sort((a, b) => b[1] - a[1])[0]![0],
        bundleLike: xs.filter((c) => c.bundleLike).length,
        bestCoin: [...xs].sort((a, b) => b.devTotalPnl - a.devTotalPnl)[0]!.info.symbol,
      };
    })
    .sort((a, b) => b.totalPnl - a.totalPnl);
  const serial = creators.filter((c) => c.launches >= 2);

  // Trade flow in active new pairs.
  const flow = FLOW_BUCKETS.map((upTo, i) => {
    const xs = active.map((c) => c.flow[i]!);
    return {
      upToSec: upTo,
      buys: sum(xs.map((f) => f.buys)),
      sells: sum(xs.map((f) => f.sells)),
      buySol: sum(xs.map((f) => f.buySol)),
      sellSol: sum(xs.map((f) => f.sellSol)),
      newBuyers: sum(xs.map((f) => f.newBuyers)),
      medianNewBuyersPerCoin: median(xs.map((f) => f.newBuyers)),
    };
  });

  // Who buys in the first five minutes of active coins. Graduated coins are left out: their later trading happens on
  // PumpSwap, which is not stored, so buyer results there are unknown.
  const onCurve = active.filter((c) => c.info.graduatedTs === null);
  const composition = new Map<string, { wallets: number; buySol: number; pnl: number; profitable: number }>();
  const early5 = onCurve.flatMap((c) => c.wallets.filter((w) => w.firstBuyAge !== null && w.firstBuyAge <= 300));
  // (wallets[] already leaves out the Mayhem agent; its result is reported per coin as agentNetSol.)
  for (const w of early5) {
    const labels = archetypes.get(w.wallet) ?? [];
    const key = labels.includes('bot_like')
      ? 'bot_like'
      : labels.includes('sniper')
        ? 'sniper'
        : labels.includes('top_performer') || labels.includes('whale')
          ? 'smart_money'
          : labels.includes('flipper') || labels.includes('aggressive')
            ? 'flipper/aggressive'
            : labels.length
              ? 'other_labelled'
              : 'unlabelled';
    const e = composition.get(key) ?? { wallets: 0, buySol: 0, pnl: 0, profitable: 0 };
    e.wallets++;
    e.buySol += w.buySol;
    e.pnl += w.pnl;
    if (w.pnl > 0) e.profitable++;
    composition.set(key, e);
  }
  const totalEarlySol = sum(early5.map((w) => w.buySol));

  const launchWindow = onCurve.flatMap((c) => c.wallets.filter((w) => w.firstBuyAge !== null && w.firstBuyAge <= 3));
  const later = onCurve.flatMap((c) => c.wallets.filter((w) => w.firstBuyAge !== null && w.firstBuyAge > 3));
  const holdOf = (ws: typeof launchWindow) =>
    median(ws.flatMap((w) => (w.firstSellAge !== null && w.firstBuyAge !== null ? [w.firstSellAge - w.firstBuyAge] : [])));

  const organicBuys = onCurve.flatMap((c) => c.wallets.filter((w) => (w.firstBuyAge ?? 0) > 3).map((w) => w.buySol));
  const reaction = active.filter((c) => c.aroundFirstSell && c.aroundFirstSell.before > 0);

  return {
    thresholds: { activeMinBuyers: ACTIVE_MIN_BUYERS, activeMinBuySol: ACTIVE_MIN_BUY_SOL, coordinationSlots: COORDINATION_SLOTS },
    summary: {
      launches: coins.length,
      active: active.length,
      feesMeasured: coins.filter((c) => !c.feesEstimated).length,
      all: profile(coins),
      activeCoins: profile(active),
      inactiveCoins: profile(coins.filter((c) => !c.active)),
    },
    profitableVsLosing: { profitable: profile(profitable), losing: profile(losing) },
    byMode: { normal: profile(active.filter((c) => !c.info.isMayhem)), mayhem: profile(active.filter((c) => c.info.isMayhem)) },
    cleanVsBundled: { clean: profile(clean), bundled: profile(bundled) },
    exits: {
      all: exitBreakdown(active),
      singleWalletClean: exitBreakdown(clean),
      singleWalletCleanNormal: exitBreakdown(clean.filter((c) => !c.info.isMayhem)),
    },
    singleWalletCleanTop: [...clean].sort((a, b) => b.devTotalPnl - a.devTotalPnl).slice(0, limit),
    topCoins: [...active].sort((a, b) => b.devTotalPnl - a.devTotalPnl).slice(0, limit),
    creators: creators.slice(0, limit),
    serialCreators: {
      count: serial.length,
      launchesShare: coins.length ? sum(serial.map((c) => c.launches)) / coins.length : null,
      profitableShare: share(serial.map((c) => c.totalPnl > 0)),
      top: serial.slice(0, limit),
      bottom: serial.slice(-Math.min(5, serial.length)).reverse(),
    },
    flow,
    buyerStatsCoins: onCurve.length,
    // Everyone's combined result on those coins, the Mayhem agent included. On a bonding curve it can only be
    // negative (fees and SOL left in the curve), so a positive total means missing trades or overvalued holdings.
    combinedResult: {
      devs: sum(onCurve.map((c) => c.devTradingPnl)),
      others: sum(onCurve.flatMap((c) => c.wallets.map((w) => w.pnl))),
      agent: sum(onCurve.map((c) => c.agentNetSol)),
    },
    composition: [...composition.entries()]
      .map(([kind, e]) => ({
        kind,
        wallets: e.wallets,
        buySolShare: totalEarlySol ? e.buySol / totalEarlySol : null,
        profitableShare: e.wallets ? e.profitable / e.wallets : null,
        pnlSol: e.pnl,
      }))
      .sort((a, b) => b.wallets - a.wallets),
    launchWindowBuyers: {
      wallets: launchWindow.length,
      profitableShare: share(launchWindow.map((w) => w.pnl > 0)),
      medianHoldSec: holdOf(launchWindow),
      totalPnl: sum(launchWindow.map((w) => w.pnl)),
    },
    laterBuyers: {
      wallets: later.length,
      profitableShare: share(later.map((w) => w.pnl > 0)),
      medianHoldSec: holdOf(later),
      totalPnl: sum(later.map((w) => w.pnl)),
    },
    organicBuySize: { p25: q(organicBuys, 0.25), p50: q(organicBuys, 0.5), p75: q(organicBuys, 0.75), p90: q(organicBuys, 0.9) },
    reactionToDevSell: {
      coins: reaction.length,
      buyingContinuedShare: share(reaction.map((c) => c.aroundFirstSell!.after >= 0.5 * c.aroundFirstSell!.before)),
      medianBuySolBefore: median(reaction.map((c) => c.aroundFirstSell!.before)),
      medianBuySolAfter: median(reaction.map((c) => c.aroundFirstSell!.after)),
      peakAfterSellShare: share(active.filter((c) => c.firstSell).map((c) => c.peakAfterFirstSell === true)),
    },
  };
}
