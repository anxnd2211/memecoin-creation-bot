import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { config, redactUrl } from '../config.ts';
import { CURVE_FEE_RATE } from '../chain/curve.ts';
import { ShadowRun, bandOf, formatSummary, skipReason, summarize, type ShadowRecord } from '../live/shadow.ts';
import { LiveFeed } from '../live/stream.ts';
import { log } from '../log.ts';
import { PLAYBOOK, exitFor } from '../playbook.ts';

/**
 * Shadow mode: runs the playbook's live exit on other devs' launches as if we were their dev, and records what our
 * whole-bag sell would have fetched (src/live/shadow.ts). Read-only websocket; never writes to the observer's database.
 */

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const num = (name: string, fallback: number): number => {
  const v = opt(name);
  const n = v === undefined ? fallback : v === 'inf' ? Infinity : Number(v);
  if (Number.isNaN(n)) {
    console.error(`--${name} expects a number, got ${v}`);
    process.exit(1);
  }
  return n;
};

const band = bandOf(PLAYBOOK.devBuyBands);
if (flag('help')) {
  console.log(`npm run shadow -- [--minutes 60] [--min-dev-buy ${band.minSol}] [--max-dev-buy ${band.maxSol}] [--exit auto|flow|timer]
                     [--follow 10] [--feed-lost 5] [--out data/shadow/runs.jsonl] [--summary]

Watches pump.fun live for normal-mode launches whose dev bought in the playbook's band (SOL into the curve, fees
excluded; --max-dev-buy inf for no upper limit) in the create transaction, and runs playbook v${PLAYBOOK.version}'s exit on
each as if we were the dev. --exit auto picks the exit the live bot would (the flow exit while the feed is at most
${PLAYBOOK.maxFeedLagSec} s behind the chain, else the ${PLAYBOOK.slowFeedExit.maxHoldSec} s timer); flow or timer forces one. --follow is minutes after
launch that creator fees are counted (the backtest's horizon). After --minutes no new launches are taken; runs in
flight finish their sell first. Each run is appended to --out as one JSON line. --summary prints the summary of
that file and exits.`);
  process.exit(0);
}

const out = opt('out') ?? 'data/shadow/runs.jsonl';
if (resolve(out) === resolve(config.dbPath) || out.endsWith('.db')) {
  console.error(`--out ${out} looks like a database; shadow writes JSON lines only`);
  process.exit(1);
}

if (flag('summary')) {
  const records = existsSync(out)
    ? readFileSync(out, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as ShadowRecord)
    : [];
  console.log(`${out}\n${formatSummary(summarize(records))}`);
  process.exit(0);
}

const minutes = num('minutes', 60);
const minDevBuy = num('min-dev-buy', band.minSol);
const maxDevBuy = num('max-dev-buy', band.maxSol);
const followSec = num('follow', 10) * 60;
const feedLostSec = num('feed-lost', 5);
const exitChoice = opt('exit') ?? 'auto';
if (!['auto', 'flow', 'timer'].includes(exitChoice)) {
  console.error(`--exit must be auto, flow or timer, got ${exitChoice}`);
  process.exit(1);
}
mkdirSync(dirname(out), { recursive: true });

const feed = new LiveFeed();
const runs = new Map<string, { run: ShadowRun; unsubscribe: () => void; logged: { decided: boolean; sold: boolean } }>();
const records: ShadowRecord[] = [];
const skipped: Record<string, number> = {};
const startedAt = Date.now();
const hardStopMs = minutes * 60_000 + (Math.max(PLAYBOOK.exit.maxHoldSec, PLAYBOOK.slowFeedExit.maxHoldSec) + 60) * 1000;
let accepting = true;
let stopping = false;

const r3 = (x: number) => Math.round(x * 1000) / 1000;

feed.onLaunch((l) => {
  if (!accepting) return;
  const why = skipReason(l, { minSol: minDevBuy, maxSol: maxDevBuy });
  if (why) {
    skipped[why] = (skipped[why] ?? 0) + 1;
    return;
  }
  if (runs.has(l.mint)) return;
  const lagSec = feed.lag.estimate(l.receivedAt);
  const auto = exitFor(PLAYBOOK, lagSec) === PLAYBOOK.exit ? 'flow' : 'timer';
  const exit = exitChoice === 'auto' ? auto : (exitChoice as 'flow' | 'timer');
  const run = new ShadowRun(l, {
    policy: exit === 'flow' ? PLAYBOOK.exit : PLAYBOOK.slowFeedExit,
    exit,
    lagSec,
    slotAt: (ms) => feed.slotAt(ms),
    lagAt: (ms) => feed.lag.estimate(ms),
    slotMs: () => feed.lag.msPerSlot(),
    feedLostSec,
    followSec,
  });
  const unsubscribe = feed.subscribe(l.mint, [l.creator, l.signer], (t) => run.onTrade(t));
  runs.set(l.mint, { run, unsubscribe, logged: { decided: false, sold: false } });
  log.info('shadowing launch', {
    mint: l.mint,
    symbol: l.symbol.trim(),
    devBuyIntoCurve: r3(l.devBuySol / (1 + CURVE_FEE_RATE)),
    exit,
    lagSec: lagSec === null ? null : Math.round(lagSec * 100) / 100,
    inFlight: runs.size,
  });
});

feed.onEvent((at) => {
  for (const { run } of runs.values()) run.onEvent(at);
});

function complete(mint: string, rec: ShadowRecord | null): void {
  const r = runs.get(mint);
  if (!r) return;
  r.unsubscribe();
  runs.delete(mint);
  if (!rec) return;
  records.push(rec);
  appendFileSync(out, JSON.stringify(rec) + '\n');
  log.info('shadow run recorded', {
    mint,
    symbol: rec.symbol.trim(),
    reason: rec.decision.reason,
    decisionSec: Math.round(rec.decision.ageSec * 10) / 10,
    result: r3(rec.result),
    recordedDev: r3(rec.recordedDev.result),
    followSec: Math.round(rec.followSec),
  });
  console.log(formatSummary(summarize(records)));
}

function tick(): void {
  const now = Date.now();
  for (const [mint, r] of runs) {
    r.run.onTick(now);
    const d = r.run.engine.decision;
    if (r.run.decided && !r.logged.decided) {
      r.logged.decided = true;
      log.info('shadow exit decided', {
        mint,
        reason: d?.reason ?? 'graduated',
        ageSec: d ? Math.round(d.ageSec * 10) / 10 : null,
        netBuying: r3(r.run.engine.netBuying(d?.at)),
      });
    }
    const sale = r.run.sale;
    if (sale && !r.logged.sold) {
      r.logged.sold = true;
      log.info('shadow sell landed', { mint, sellSol: r3(sale.sellSol), tradingPnl: r3(sale.tradingPnl), ageSec: Math.round(sale.ageSec * 10) / 10 });
    }
    if (r.run.done) complete(mint, r.run.record());
  }
  if (accepting && now - startedAt >= minutes * 60_000) {
    accepting = false;
    log.info('time is up: no new launches; finishing runs in flight', { inFlight: runs.size });
  }
  // Runs in flight get until their sell lands; a run stuck past its longest hold is dropped.
  if (!accepting && ([...runs.values()].every((r) => r.run.sold) || now - startedAt >= hardStopMs)) shutdown();
}

function status(): void {
  const now = Date.now();
  const lag = feed.lag.estimate(now);
  const s = feed.streamStats;
  log.info('status', {
    connected: s?.connectedSince != null,
    reconnects: s?.reconnects ?? 0,
    lagP95: lag === null ? null : Math.round(lag * 100) / 100,
    lagMedian: (() => {
      const m = feed.lag.median(now);
      return m === null ? null : Math.round(m * 100) / 100;
    })(),
    msPerSlot: Math.round(feed.lag.msPerSlot()),
    exit: exitChoice === 'auto' ? (exitFor(PLAYBOOK, lag) === PLAYBOOK.exit ? 'flow' : 'timer') : exitChoice,
    launches: feed.stats.launches,
    inFlight: runs.size,
    recorded: records.length,
    skipped,
  });
}

function shutdown(): void {
  if (stopping) process.exit(1);
  stopping = true;
  const now = Date.now();
  let dropped = 0;
  for (const [mint, r] of [...runs]) {
    const rec = r.run.finish(now);
    if (!rec) dropped++;
    complete(mint, rec);
  }
  feed.stop();
  clearInterval(ticker);
  clearInterval(reporter);
  if (dropped) log.info('runs dropped before their sell landed', { dropped });
  console.log(`\n${formatSummary(summarize(records))}\nappended ${records.length} runs to ${out}`);
  process.exit(0);
}

log.info('shadow mode starting', {
  rpc: redactUrl(config.rpcWs),
  commitment: config.commitment,
  playbook: PLAYBOOK.version,
  devBuyIntoCurve: [minDevBuy, maxDevBuy],
  exit: exitChoice,
  minutes,
  followMin: followSec / 60,
  out,
});
feed.start();
const ticker = setInterval(tick, 100);
const reporter = setInterval(status, 30_000);
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
