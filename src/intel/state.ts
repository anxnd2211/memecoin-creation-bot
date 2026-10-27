/** Seconds after launch at which a coin's progress is snapshotted. */
export const CHECKPOINTS = [60, 300, 900, 3600] as const;

/** Upper bounds (seconds) of the hold-time histogram buckets; the last bucket is open-ended. */
export const HOLD_BUCKETS = [5, 15, 30, 60, 180, 600, 1800, 3600, 21600, 86400, Infinity] as const;

export interface Checkpoint {
  buyers: number;
  mcapSol: number | null;
  volumeSol: number;
  trades: number;
}

export interface CoinMeta {
  description: string | null;
  image: string | null;
  twitter: string | null;
  telegram: string | null;
  website: string | null;
}

export interface CoinState {
  mint: string;
  name: string | null;
  symbol: string | null;
  uri: string | null;
  creator: string | null;
  quote: string;
  /** Null for coins launched before the observer saw them. */
  createdTs: number | null;
  createSig: string | null;
  totalSupply: number;
  isMayhem: boolean;
  isHolderReward: boolean;
  launchPriceSol: number | null;
  trades: number;
  buys: number;
  sells: number;
  uniqueBuyers: number;
  /** Buyers whose first buy landed within seconds of launch: snipers and bundled launch buys. */
  earlyBuyers: number;
  volumeSol: number;
  lastPriceSol: number | null;
  lastMcapSol: number | null;
  peakMcapSol: number;
  peakTs: number | null;
  lastTradeTs: number | null;
  devBought: number;
  devSold: number;
  devFirstSellTs: number | null;
  devSoldAllTs: number | null;
  graduatedTs: number | null;
  pool: string | null;
  smartBuys: number;
  firstSmartBuyTs: number | null;
  checkpoints: Record<string, Checkpoint>;
  metaStatus: 'none' | 'queued' | 'done' | 'failed';
  meta: CoinMeta | null;
  // In memory only.
  buyers: Set<string>;
  tractionSignaled: boolean;
  touchedAt: number;
}

export interface WalletState {
  wallet: string;
  firstTs: number;
  lastTs: number;
  trades: number;
  buys: number;
  sells: number;
  volumeSol: number;
  buySol: number;
  maxBuySol: number;
  /** Buys of at least THRESHOLDS.whaleLargeBuySol outside a coin's launch second. */
  largeBuys: number;
  /** Positions opened (first buy of a coin, or re-entry after a full exit). */
  opened: number;
  /** Fully exited positions whose whole history was observed. */
  closed: number;
  wins: number;
  realizedSol: number;
  /** Realized PnL with a 24 h half-life, so it reflects recent form. */
  pnlDecayed: number;
  /** Trade count with a 24 h half-life; times ln 2 approximates trades per day. */
  tradesDecayed: number;
  decayTs: number;
  /** Entries within a few seconds of launch. */
  snipes: number;
  /** Entries into coins whose launch time is known. */
  knownEntries: number;
  launches: number;
  openNow: number;
  maxOpen: number;
  holdHist: number[];
  /** Trades per UTC hour of day. */
  hourHist: number[];
  /** Recent active days (days since epoch), newest last. */
  days: number[];
  /** Positions opened per hour bucket (hours since epoch), recent hours only. */
  hourOpens: Record<string, number>;
  archetypes: string[];
  touchedAt: number;
}

export interface PositionState {
  wallet: string;
  mint: string;
  tokens: number;
  peakTokens: number;
  /** Cost basis of the tokens still held (average cost). */
  basisSol: number;
  costSol: number;
  proceedsSol: number;
  realizedSol: number;
  buys: number;
  sells: number;
  firstTs: number;
  lastTs: number;
  closedTs: number | null;
  /** Seconds between the coin's launch and this position's first buy, when the launch was observed. */
  entryDelay: number | null;
  /** False when part of the position predates the observer or a trade could not be valued in SOL. */
  complete: boolean;
  touchedAt: number;
}

export function newCoin(mint: string, quote: string): CoinState {
  return {
    mint,
    name: null,
    symbol: null,
    uri: null,
    creator: null,
    quote,
    createdTs: null,
    createSig: null,
    totalSupply: 1_000_000_000,
    isMayhem: false,
    isHolderReward: false,
    launchPriceSol: null,
    trades: 0,
    buys: 0,
    sells: 0,
    uniqueBuyers: 0,
    earlyBuyers: 0,
    volumeSol: 0,
    lastPriceSol: null,
    lastMcapSol: null,
    peakMcapSol: 0,
    peakTs: null,
    lastTradeTs: null,
    devBought: 0,
    devSold: 0,
    devFirstSellTs: null,
    devSoldAllTs: null,
    graduatedTs: null,
    pool: null,
    smartBuys: 0,
    firstSmartBuyTs: null,
    checkpoints: {},
    metaStatus: 'none',
    meta: null,
    buyers: new Set(),
    tractionSignaled: false,
    touchedAt: Date.now(),
  };
}

export function coinFromRow(r: Record<string, any>): CoinState {
  return {
    ...newCoin(r.mint, r.quote),
    name: r.name,
    symbol: r.symbol,
    uri: r.uri,
    creator: r.creator,
    createdTs: r.created_ts,
    createSig: r.create_sig,
    totalSupply: r.total_supply,
    isMayhem: r.is_mayhem === 1,
    isHolderReward: r.is_holder_reward === 1,
    launchPriceSol: r.launch_price_sol,
    trades: r.trades,
    buys: r.buys,
    sells: r.sells,
    uniqueBuyers: r.unique_buyers,
    earlyBuyers: r.early_buyers,
    volumeSol: r.volume_sol,
    lastPriceSol: r.last_price_sol,
    lastMcapSol: r.last_mcap_sol,
    peakMcapSol: r.peak_mcap_sol,
    peakTs: r.peak_ts,
    lastTradeTs: r.last_trade_ts,
    devBought: r.dev_bought,
    devSold: r.dev_sold,
    devFirstSellTs: r.dev_first_sell_ts,
    devSoldAllTs: r.dev_sold_all_ts,
    graduatedTs: r.graduated_ts,
    pool: r.pool,
    smartBuys: r.smart_buys,
    firstSmartBuyTs: r.first_smart_buy_ts,
    checkpoints: JSON.parse(r.checkpoints),
    metaStatus: r.meta_status,
    meta:
      r.meta_status === 'done'
        ? { description: r.description, image: r.image, twitter: r.twitter, telegram: r.telegram, website: r.website }
        : null,
    // Reloaded coins have already been past the traction window or were evicted after it.
    tractionSignaled: true,
  };
}

export function newWallet(wallet: string, ts: number): WalletState {
  return {
    wallet,
    firstTs: ts,
    lastTs: ts,
    trades: 0,
    buys: 0,
    sells: 0,
    volumeSol: 0,
    buySol: 0,
    maxBuySol: 0,
    largeBuys: 0,
    opened: 0,
    closed: 0,
    wins: 0,
    realizedSol: 0,
    pnlDecayed: 0,
    tradesDecayed: 0,
    decayTs: ts,
    snipes: 0,
    knownEntries: 0,
    launches: 0,
    openNow: 0,
    maxOpen: 0,
    holdHist: HOLD_BUCKETS.map(() => 0),
    hourHist: new Array(24).fill(0),
    days: [],
    hourOpens: {},
    archetypes: [],
    touchedAt: Date.now(),
  };
}

export function walletFromRow(r: Record<string, any>): WalletState {
  return {
    wallet: r.wallet,
    firstTs: r.first_ts,
    lastTs: r.last_ts,
    trades: r.trades,
    buys: r.buys,
    sells: r.sells,
    volumeSol: r.volume_sol,
    buySol: r.buy_sol,
    maxBuySol: r.max_buy_sol,
    largeBuys: r.large_buys ?? 0,
    opened: r.opened,
    closed: r.closed,
    wins: r.wins,
    realizedSol: r.realized_sol,
    pnlDecayed: r.pnl_decayed,
    tradesDecayed: r.trades_decayed,
    decayTs: r.decay_ts,
    snipes: r.snipes,
    knownEntries: r.known_entries,
    launches: r.launches,
    openNow: r.open_now,
    maxOpen: r.max_open,
    holdHist: JSON.parse(r.hold_hist),
    hourHist: JSON.parse(r.hour_hist),
    days: JSON.parse(r.days),
    hourOpens: JSON.parse(r.hour_opens),
    archetypes: r.archetypes ? String(r.archetypes).split(',') : [],
    touchedAt: Date.now(),
  };
}

export function newPosition(wallet: string, mint: string, ts: number): PositionState {
  return {
    wallet,
    mint,
    tokens: 0,
    peakTokens: 0,
    basisSol: 0,
    costSol: 0,
    proceedsSol: 0,
    realizedSol: 0,
    buys: 0,
    sells: 0,
    firstTs: ts,
    lastTs: ts,
    closedTs: null,
    entryDelay: null,
    complete: true,
    touchedAt: Date.now(),
  };
}

export function positionFromRow(wallet: string, mint: string, r: Record<string, any>): PositionState {
  return {
    wallet,
    mint,
    tokens: r.tokens,
    peakTokens: r.peak_tokens,
    basisSol: r.basis_sol,
    costSol: r.cost_sol,
    proceedsSol: r.proceeds_sol,
    realizedSol: r.realized_sol,
    buys: r.buys,
    sells: r.sells,
    firstTs: r.first_ts,
    lastTs: r.last_ts,
    closedTs: r.closed_ts,
    entryDelay: r.entry_delay,
    complete: r.complete === 1,
    touchedAt: Date.now(),
  };
}
