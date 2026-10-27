import { statfsSync } from 'node:fs';
import { dirname } from 'node:path';
import { config, redactUrl } from '../config.ts';
import { ConfirmGate } from '../chain/confirm.ts';
import { PayloadDeduper, decodeTx, type DecodeStats } from '../chain/decoder.ts';
import type { DecodedEvent } from '../chain/events.ts';
import { PoolResolver } from '../chain/pools.ts';
import { PUMP_AMM_PROGRAM, PUMP_PROGRAM } from '../chain/programs.ts';
import { RpcLogStream } from '../chain/sources/rpcLogs.ts';
import { Engine, type Signal } from '../intel/engine.ts';
import { relabelWalletsIfRulesChanged } from '../intel/relabel.ts';
import { log } from '../log.ts';
import { MetadataFetcher } from '../market/metadata.ts';
import { PriceBook } from '../market/prices.ts';
import { Store } from '../store/db.ts';

const FLUSH_MS = 2_000;
const SWEEP_MS = 60_000;
const STATUS_MS = 30_000;
const PRUNE_MS = 3600_000;
const WRITE_OFF_MS = 10 * 60_000;

const store = new Store(config.dbPath);
const relabelled = relabelWalletsIfRulesChanged(store, Math.floor(Date.now() / 1000));
if (relabelled !== null) log.info('archetype rules changed; relabelled stored wallets', { changed: relabelled });
// Creator fees are complete only for coins launched after capture began.
if (store.getMeta('creator_fees_since') === undefined) store.setMeta('creator_fees_since', Math.floor(Date.now() / 1000));
const prices = new PriceBook(config.jupiterApiKey);
await prices.start();
log.info('SOL price loaded', { usd: prices.solUsd });

const quietSignals = new Set(['dev_sold_all']);
function printSignal(s: Signal): void {
  if (quietSignals.has(s.kind)) return;
  log.info(`signal ${s.kind}`, { mint: s.mint, ...(s.wallet ? { wallet: s.wallet } : {}), ...s.detail });
}

let metadata: MetadataFetcher;
const engine = new Engine(store, prices, {
  storeTrades: config.storeTrades,
  metadataMinBuyers: config.metadataMinBuyers,
  metadataSampleRate: config.metadataSampleRate,
  onSignal: printSignal,
  onWantMetadata: (mint, uri) => metadata.enqueue(mint, uri),
});
metadata = new MetadataFetcher(config.ipfsGateways, (mint, status, meta) => engine.setMeta(mint, status, meta));

const resolver = new PoolResolver(config.rpcHttp, store, (t) => engine.handle(t));
resolver.start();

const decodeStats: DecodeStats = { undecodable: 0, duplicates: 0 };
const dedupe = new PayloadDeduper();
let truncatedTxs = 0;
let lags: number[] = [];

interface DecodedTx {
  sig: string;
  events: DecodedEvent[];
}

/** Lag here is end to end: block time to state update, including the confirmation check. */
function processTx(tx: DecodedTx): void {
  const now = Date.now() / 1000;
  for (const ev of tx.events) {
    if (lags.length < 20_000) lags.push(now - ev.ts);
    switch (ev.kind) {
      case 'pool_trade':
        resolver.handle(ev);
        break;
      case 'pool':
        resolver.learnPool(ev);
        break;
      case 'migrate':
        resolver.learnMigration(ev);
        engine.handle(ev);
        break;
      default:
        engine.handle(ev);
    }
  }
}

const gate = config.verifyTxs ? new ConfirmGate<DecodedTx>(config.rpcHttp, processTx) : null;
gate?.start();

const stream = new RpcLogStream({
  url: config.rpcWs,
  programs: [PUMP_PROGRAM, PUMP_AMM_PROGRAM],
  commitment: config.commitment,
  onTx: (tx) => {
    const { events, truncated } = decodeTx(tx, decodeStats, dedupe);
    if (truncated) truncatedTxs++;
    if (events.length === 0) return;
    const decoded = { sig: tx.sig, events };
    if (gate) gate.push(decoded);
    else processTx(decoded);
  },
});

log.info('observer starting', {
  rpc: redactUrl(config.rpcWs),
  commitment: config.commitment,
  db: config.dbPath,
  storeTrades: config.storeTrades,
});
stream.start();

function safeFlush(): void {
  try {
    engine.flush();
  } catch (err) {
    log.error('flush failed', { error: String(err) });
  }
}

function percentile(sorted: number[], q: number): number | null {
  return sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]! * 100) / 100 : null;
}

function freeDiskGb(): number {
  const s = statfsSync(dirname(config.dbPath));
  return (s.bavail * s.bsize) / 1e9;
}

let last = { at: Date.now(), received: 0, trades: 0, curve: 0, amm: 0, launches: 0 };
function status(): void {
  const now = Date.now();
  const secs = (now - last.at) / 1000;
  const c = engine.counters;
  const sorted = lags.sort((a, b) => a - b);
  const snapshot = {
    at: new Date(now).toISOString(),
    connected: stream.stats.connectedSince !== null,
    txPerSec: Math.round((stream.stats.received - last.received) / secs),
    curveTradesPerSec: Math.round(((c.curveTrades - last.curve) / secs) * 10) / 10,
    ammTradesPerSec: Math.round(((c.ammTrades - last.amm) / secs) * 10) / 10,
    launchesPerMin: Math.round(((c.launches - last.launches) / secs) * 60 * 10) / 10,
    lagP50: percentile(sorted, 0.5),
    lagP95: percentile(sorted, 0.95),
    reconnects: stream.stats.reconnects,
    gapSeconds: Math.round(stream.stats.gapSeconds),
    memory: { coins: engine.coins.size, wallets: engine.wallets.size, positions: engine.positions.size },
    pendingPoolTrades: resolver.pendingCount,
    confirm: gate ? { ...gate.stats, pending: gate.pendingCount } : null,
    pools: resolver.stats,
    unvaluedTrades: c.unvalued,
    abandonedWrittenOff: c.writeOffs,
    truncatedTxs,
    undecodable: decodeStats.undecodable,
    duplicateEvents: decodeStats.duplicates,
    metadata: { ...metadata.stats, queued: metadata.queued },
    solUsd: prices.solUsd,
    tradeWrites: engine.tradeWritesEnabled,
    rssMb: Math.round(process.memoryUsage().rss / 1e6),
  };
  log.info('status', {
    tx_s: snapshot.txPerSec,
    curve_s: snapshot.curveTradesPerSec,
    amm_s: snapshot.ammTradesPerSec,
    launch_min: snapshot.launchesPerMin,
    lag_p50: snapshot.lagP50,
    lag_p95: snapshot.lagP95,
    mem: snapshot.memory,
    pending: snapshot.pendingPoolTrades,
    dupes: decodeStats.duplicates,
    rssMb: snapshot.rssMb,
  });
  store.setMeta('observer_status', snapshot);
  last = { at: now, received: stream.stats.received, trades: c.trades, curve: c.curveTrades, amm: c.ammTrades, launches: c.launches };
  lags = [];
}

function guardDisk(): void {
  const free = freeDiskGb();
  const enabled = free >= config.minFreeDiskGb;
  if (enabled !== engine.tradeWritesEnabled) {
    engine.tradeWritesEnabled = enabled;
    if (enabled) log.info('disk space recovered; raw trade writes resumed', { freeGb: Math.round(free) });
    else log.warn('low disk space; raw trade writes paused (aggregates still saved)', { freeGb: Math.round(free) });
  }
}

function prune(): void {
  try {
    const removed = store.prune(Math.floor(Date.now() / 1000), config.tradeRetentionDays, config.positionRetentionDays);
    if (removed.trades || removed.positions) log.info('pruned old rows', removed);
  } catch (err) {
    log.error('prune failed', { error: String(err) });
  }
}

guardDisk();
prune();
// Clear the backlog of abandoned positions before streaming, then keep up every few minutes.
let writtenOff = 0;
for (let i = 0, n; i < 100 && (n = engine.writeOffAbandoned(Math.floor(Date.now() / 1000))); i++) writtenOff += n;
engine.sweep();
if (writtenOff) log.info('closed abandoned positions on dead coins', { positions: writtenOff });
const timers = [
  setInterval(safeFlush, FLUSH_MS),
  setInterval(() => {
    safeFlush();
    engine.sweep();
    guardDisk();
  }, SWEEP_MS),
  setInterval(status, STATUS_MS),
  setInterval(prune, PRUNE_MS),
  setInterval(() => engine.writeOffAbandoned(Math.floor(Date.now() / 1000)), WRITE_OFF_MS),
];

let stopping = false;
function shutdown(): void {
  if (stopping) return;
  stopping = true;
  log.info('stopping observer');
  stream.stop();
  gate?.stop();
  resolver.stop();
  prices.stop();
  for (const t of timers) clearInterval(t);
  safeFlush();
  store.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// `--for <seconds>` runs for a fixed time, for smoke tests.
const forIdx = process.argv.indexOf('--for');
if (forIdx > 0) {
  const secs = Number(process.argv[forIdx + 1]);
  if (secs > 0) setTimeout(() => {
    status();
    shutdown();
  }, secs * 1000);
}
