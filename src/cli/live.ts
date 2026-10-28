import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config.ts';
import { log } from '../log.ts';
import { PLAYBOOK } from '../playbook.ts';
import { loadBacktestCoins } from '../sim/backtest.ts';
import { Store } from '../store/db.ts';
import { autoDraft } from '../live/autodraft.ts';
import { DEFAULT_LIMITS, boardState, launchBoard } from '../live/board.ts';
import { DesignError, buildDraft, checkCompliance, fetchPost, parsePost, sniffImage } from '../live/designer.ts';
import { ExitEngine } from '../live/exit.ts';
import { replayOnFork } from '../live/forkReplay.ts';
import { pinMetadata } from '../live/ipfs.ts';
import { sellLeftoverBags } from '../live/recover.ts';
import { runLaunch, type LaunchDeps } from '../live/launcher.ts';
import { LiveFeed } from '../live/stream.ts';
import { TelegramNotifier, USAGE, type CommandMessage } from '../live/telegram.ts';
import type { CoinDraft, LiveTrade, Mode, Notifier, PostInfo, Venue } from '../live/types.ts';
import { DryVenue, ForkVenue, MainnetVenue } from '../live/venue.ts';
import { XWatcher, type XPostCandidate } from '../live/xwatch.ts';

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

if (args.includes('--help')) {
  console.log(`usage: npm run live -- --mode fork|dry|live [--replay <mint>] [--speed 1]

Runs the launcher under playbook v${PLAYBOOK.version} (docs/LIVE-RUNBOOK.md).
  fork  one launch end to end on the local copy of pump.fun: a recorded launch's traders (--replay <mint>, or the most
        recent recorded 5 SOL launch that drew buyers) are replayed against our coin in real time (--speed > 1
        compresses the exit's windows too), while the exit manager decides when to sell. Approvals are automatic; nothing touches mainnet.
  dry   the real feed, the observer's database and Telegram: launch cards come from /launch or the X watcher, every
        gate runs and you approve on Telegram, but the launch and the sell are simulated against mainnet, never sent.
  live  real launches from the wallet in LAUNCH_KEYPAIR_PATH, each approved by you on Telegram.
Stop launching at any time with /kill on Telegram or by creating the file data/KILL.`);
  process.exit(0);
}

const mode = (opt('mode') ?? 'fork') as Mode;
if (!['fork', 'dry', 'live'].includes(mode)) {
  console.error('--mode must be fork, dry or live');
  process.exit(1);
}
const KILL_FILE = 'data/KILL';
const killed = () => existsSync(KILL_FILE);
const store = new Store(config.dbPath);
const db: DatabaseSync = store.db;
const now = () => Math.floor(Date.now() / 1000);

/** Prints to the console and approves every card: fork runs only. */
const consoleNotifier: Notifier = {
  send: async (text) => console.log(`\n${text}`),
  askApproval: async (card) => {
    console.log(`\n--- launch card (auto-approved in fork mode) ---\n${card.text}\n---`);
    return { approved: true, by: 'owner', at: Date.now() };
  },
};

/** A 1x1 PNG, for fork runs that have no coin image. */
const PLACEHOLDER_PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));

async function forkRun(): Promise<void> {
  const venue = await ForkVenue.open();
  // The recorded launch whose traders we replay: the one asked for, or the latest that met the playbook's rules.
  const since = now() - 14 * 86400;
  const coins = loadBacktestCoins(db, since, now() - 600);
  const wanted = opt('replay');
  const pick = wanted
    ? coins.find((c) => c.mint === wanted)
    : coins.filter((c) => c.launchBuySol >= 4.9 && c.active).sort((a, b) => b.createdTs - a.createdTs)[0];
  if (!pick) throw new Error(wanted ? `no recorded launch ${wanted}` : 'no recorded 5 SOL launch to replay');
  // Real time by default: the exit engine's clock is the wall clock, so a sped-up replay compresses its windows too.
  const speed = Number(opt('speed') ?? 1);
  console.log(`Replaying the traders of $${pick.symbol} (${pick.mint}) against our coin on the fork, ${speed}x speed.`);
  // A fresh post, so the board's first-on-post and farmed-account gates see a post nobody has launched on.
  const postId = String(BigInt(Date.now() - 1288834974657) << 22n);
  const post: PostInfo = { url: `https://x.com/forkrun/status/${postId}`, handle: 'forkrun', postId, postedAt: now() - 5, authorName: 'fork run', text: 'fork run' };
  // A ticker of its own, so the crowded-ticker gate does not see the recorded coin's.
  const draft: CoinDraft = {
    name: `Fork run ${(pick.symbol ?? '').slice(0, 20)}`.trim(),
    symbol: `FRK${Date.now().toString(36).slice(-5).toUpperCase()}`,
    description: 'fork run',
    postUrl: post.url,
    website: 'https://www.example.com/fork-run',
    image: { bytes: PLACEHOLDER_PNG, mime: 'image/png', filename: 'fork.png' },
  };
  let sold = false;
  const deps = baseDeps(venue, consoleNotifier, null);
  deps.limits = { ...DEFAULT_LIMITS, maxObserverStaleSec: Infinity };
  deps.uploadMetadata = async () => 'https://ipfs.io/ipfs/fork-run';
  deps.settleSec = Math.max(1, Math.round(60 / speed));
  deps.watch = (mint, landing, onTrade) => {
    let stop = false;
    void replayOnFork(venue.fork, mint, pick.trades, {
      speed,
      launchChainTs: Math.floor(landing.landedAt / 1000),
      onTrade,
      sold: () => sold,
      stop: () => stop,
    }).then((s) => console.log(`replay: ${s.replayed} trades, ${s.skippedSells} sells skipped, ${s.failed} failed ${s.errors.join('; ')}`));
    return () => {
      stop = true;
    };
  };
  const sellAll = venue.sellAll.bind(venue);
  venue.sellAll = async (mint: string, o: Parameters<Venue['sellAll']>[1]) => {
    const r = await sellAll(mint, o);
    sold = true;
    return r;
  };
  const r = await runLaunch(deps, post, draft, 'fork run');
  console.log(`\nResult: ${JSON.stringify(r, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 1)}`);
}

/** The launch sequence's dependencies for this mode; `feed` is the live trade feed (null in fork runs). */
function baseDeps(venue: Venue, notifier: Notifier, feed: LiveFeed | null): LaunchDeps {
  return {
    venue,
    notifier,
    db,
    playbook: PLAYBOOK,
    limits: DEFAULT_LIMITS,
    now,
    killed,
    feedLag: () => (feed ? feed.lag.estimate(Date.now()) : 0.4),
    checkCompliance,
    uploadMetadata: async (draft) => {
      if (mode !== 'live') return 'https://ipfs.io/ipfs/dry-run-not-uploaded';
      const jwt = process.env.PINATA_JWT;
      if (!jwt) throw new Error('PINATA_JWT is not set: metadata cannot be uploaded');
      return pinMetadata(draft, { jwt });
    },
    watch: (mint, _landing, onTrade) => (feed ? feed.subscribe(mint, venue.dev, onTrade) : () => {}),
    makeExit: (policy, landing) => {
      // Without a live feed (fork runs) only our coin's trades arrive, so a quiet coin must not look like a lost feed.
      const engine = new ExitEngine(policy, landing, venue.dev, feed ? {} : { feedLostSec: Infinity });
      // Every feed event tells the engine the feed is alive; a decision it makes then is handed over on the next call.
      const off = feed ? feed.onEvent((ms) => void engine.onEvent(ms)) : () => {};
      let handed = false;
      const hand = () => {
        const d = engine.decision;
        if (!d || handed) return null;
        handed = true;
        off();
        return d;
      };
      return {
        onTrade: (t) => (engine.onTrade(t), hand()),
        onTick: (nowMs) => (engine.onTick(nowMs), hand()),
        kill: (nowMs) => {
          off();
          return engine.kill(nowMs);
        },
      };
    },
  };
}

async function liveRun(): Promise<void> {
  const venue: Venue = mode === 'live' ? await MainnetVenue.fromConfig() : await DryVenue.fromConfig();
  const tg = new TelegramNotifier();
  const feed = new LiveFeed();
  feed.start();
  const deps = baseDeps(venue, tg, feed);
  let busy = false;
  process.on('unhandledRejection', (e) => {
    log.error('unhandled rejection', { err: (e as Error)?.message ?? String(e) });
    void tg.send(`Internal error (the launcher keeps running): ${(e as Error)?.message ?? String(e)}`);
  });
  // A bag left by an earlier run (a crash or restart between a launch and its sell) is sold before anything else.
  const leftover = await sellLeftoverBags(db, venue, tg, PLAYBOOK);
  if (leftover.failed.length) await tg.send(`${leftover.failed.length} leftover bag(s) still held: launching is paused until they are sold.`);
  if (leftover.failed.length) writeFileSync(KILL_FILE, `leftover bags unsold at start: ${leftover.failed.join(', ')}\n`);
  const balance = await venue.balanceLamports().catch(() => null);
  await tg.send(
    `Launcher started in ${mode} mode, playbook v${PLAYBOOK.version}. Wallet ${venue.dev}: ` +
      `${balance === null ? 'balance unknown' : `${(Number(balance) / 1e9).toFixed(4)} SOL`}. ` +
      `Dev buy ${PLAYBOOK.devBuySol} SOL; kill switch ${killed() ? 'ON' : 'off'}.\n\n${USAGE}`,
  );

  const launch = async (post: PostInfo, draft: CoinDraft, narrative: string) => {
    if (busy) {
      await tg.send(`Busy with a launch; $${draft.symbol} skipped.`);
      return;
    }
    busy = true;
    try {
      const r = await runLaunch(deps, post, draft, narrative);
      log.info('launch finished', { status: r.status, symbol: draft.symbol });
    } catch (e) {
      await tg.send(`Launch of $${draft.symbol} stopped by an error: ${(e as Error).message}`);
    } finally {
      busy = false;
    }
  };

  const onCommand = async (m: CommandMessage) => {
    const c = m.command;
    if (c.kind === 'kill') {
      writeFileSync(KILL_FILE, `killed from Telegram at ${new Date().toISOString()}\n`);
      await tg.send('Kill switch ON: no new launches; an open bag is sold now.');
    } else if (c.kind === 'resume') {
      rmSync(KILL_FILE, { force: true });
      await tg.send('Kill switch off: launches allowed again.');
    } else if (c.kind === 'status') {
      const lag = feed.lag.estimate(Date.now());
      const ours = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(pnl_sol), 0) AS pnl FROM our_launches WHERE mode = ? AND created_ts >= ?`).get(mode, now() - (now() % 86400)) as { n: number; pnl: number };
      await tg.send(`${mode} mode, ${busy ? 'launch in progress' : 'idle'}; kill switch ${killed() ? 'ON' : 'off'}; feed lag ${lag === null ? 'unknown' : `${lag.toFixed(1)} s`}; today ${ours.n} launches, ${ours.pnl.toFixed(4)} SOL.`);
    } else if (c.kind === 'claim') {
      if (!(venue instanceof MainnetVenue)) {
        await tg.send('Nothing to claim in this mode.');
        return;
      }
      try {
        const r = await venue.claimCreatorFees();
        await tg.send(
          r === null
            ? 'Less than 0.002 SOL of creator fees waiting: not worth a claim yet.'
            : `${r.signature ? 'Claimed' : 'Would claim (dry run)'} ${(Number(r.lamports) / 1e9).toFixed(4)} SOL of creator fees${r.signature ? `: ${r.signature}` : ''}.`,
        );
      } catch (e) {
        await tg.send(`Creator fee claim failed: ${(e as Error).message}`);
      }
    } else if (c.kind === 'launch') {
      try {
        const post = await fetchPost(c.postUrl);
        const draft = buildDraft(post, { name: c.name, ticker: c.ticker, sourceUrl: c.sourceUrl, description: c.description, image: m.image });
        await launch(post, draft, post.text ?? c.name);
      } catch (e) {
        const problems = e instanceof DesignError ? e.problems.join('; ') : (e as Error).message;
        await tg.send(`Cannot launch: ${problems}`);
      }
    }
  };

  // Posts from watched accounts become launch cards with a drafted name, ticker and the post's image.
  const bearer = process.env.X_BEARER_TOKEN;
  let watcher: XWatcher | null = null;
  if (bearer && existsSync('data/watchlist.json')) {
    const handles = (JSON.parse(readFileSync('data/watchlist.json', 'utf8')) as { accounts: { handle: string }[] }).accounts.map((a) => a.handle);
    watcher = new XWatcher({
      bearer,
      handles,
      onStatus: (s) => log.info(s),
      onPost: (c) => void onCandidate(c),
    });
    void watcher.start().catch((e) => void tg.send(`X watcher stopped: ${(e as Error).message}`));
  }
  const onCandidate = async (c: XPostCandidate) => {
    if (busy || killed()) return;
    const d = autoDraft(c.text);
    if (!d || !c.imageUrl) {
      await tg.send(`New post from @${c.handle}: ${c.url}\nNo automatic draft (${!d ? 'no usable words' : 'no image'}). Send /launch with a photo to launch on it.`);
      return;
    }
    try {
      const res = await fetch(c.imageUrl, { signal: AbortSignal.timeout(5_000) });
      const bytes = new Uint8Array(await res.arrayBuffer());
      const mime = sniffImage(bytes);
      if (!mime) throw new Error('the post image is not a PNG, JPEG, GIF or WEBP');
      const post = { ...parsePost(c.url), authorName: null, text: c.text };
      const draft = buildDraft(post, { name: d.name, ticker: d.symbol, image: { bytes, mime, filename: `post.${mime.split('/')[1]}` } });
      // A silent first check, so posts that fail the board do not each send a message.
      const pre = launchBoard({ playbook: PLAYBOOK, limits: DEFAULT_LIMITS, post, draft, state: boardState(db, post, draft.symbol, now(), { balanceLamports: await venue.balanceLamports().catch(() => null), killed: killed() }), compliance: checkCompliance(draft, post), preflight: null, approved: null }, 'before preflight');
      if (!pre.pass) return;
      await launch(post, draft, `${c.text} (auto draft from ${d.basis})`);
    } catch (e) {
      log.warn('candidate skipped', { url: c.url, err: (e as Error).message });
    }
  };

  const stop = new AbortController();
  const shutdown = () => {
    stop.abort();
    watcher?.stop();
    feed.stop();
    tg.close();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  await tg.runCommands(onCommand, stop.signal);
}

try {
  if (mode === 'fork') await forkRun();
  else await liveRun();
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  store.close?.();
}
