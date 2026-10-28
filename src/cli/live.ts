import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config.ts';
import { candidateUrls, parseMeta } from '../market/metadata.ts';
import { log } from '../log.ts';
import { PLAYBOOK, type Playbook } from '../playbook.ts';
import { loadBacktestCoins } from '../sim/backtest.ts';
import { Store } from '../store/db.ts';
import { autoDraft } from '../live/autodraft.ts';
import { DEFAULT_LIMITS, boardState, launchBoard } from '../live/board.ts';
import { DesignError, buildDraft, checkCompliance, fetchPost, parsePost, sniffImage } from '../live/designer.ts';
import { ExitEngine } from '../live/exit.ts';
import { replayOnFork } from '../live/forkReplay.ts';
import { pinMetadata } from '../live/ipfs.ts';
import { sellLeftoverBags } from '../live/recover.ts';
import { takeVanity, vanityLeft } from '../live/vanity.ts';
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
  console.log(`usage: npm run live -- --mode fork|dry|live [--smoke] [--replay <mint>] [--speed 1]

Runs the launcher under playbook v${PLAYBOOK.version} (docs/LIVE-RUNBOOK.md).
  fork  one launch end to end on the local copy of pump.fun: a recorded launch's traders (--replay <mint>, or the most
        recent recorded 5 SOL launch that drew buyers) are replayed against our coin in real time (--speed > 1
        compresses the exit's windows too), while the exit manager decides when to sell. Approvals are automatic; nothing touches mainnet.
  dry   the real feed, the observer's database and Telegram: launch cards come from /launch or the X watcher, every
        gate runs and you approve on Telegram, but the launch and the sell are simulated against mainnet, never sent.
  live  real launches from the wallet in LAUNCH_KEYPAIR_PATH, each approved by you on Telegram.
  --smoke  with live: one real launch with a 0.1 SOL dev buy (about 0.012 SOL of cost) to check everything end to end.
        Use a separate test wallet: a dead launch in the launch wallet's history costs it snipers later.
Stop launching at any time with /kill on Telegram or by creating the file data/KILL.`);
  process.exit(0);
}

const mode = (opt('mode') ?? 'fork') as Mode;
/**
 * A smoke test: one real launch with a 0.1 SOL dev buy, to prove keys, metadata, Telegram, landing, the live exit,
 * the sell and the accounting on mainnet for about 0.012 SOL. Run it from a separate test wallet: a dead launch in
 * the launch wallet's history costs it snipers later. Recorded as 'smoke', apart from real launches.
 */
const smoke = args.includes('--smoke');
const playbook: Playbook = smoke ? { ...PLAYBOOK, devBuySol: 0.10125, devBuyBands: ['<1'] } : PLAYBOOK;
if (!['fork', 'dry', 'live'].includes(mode)) {
  console.error('--mode must be fork, dry or live');
  process.exit(1);
}
const KILL_FILE = 'data/KILL';
/** Set when the process is shutting down: no launch may start, even one already approved. */
let stopping = false;
const killed = () => stopping || existsSync(KILL_FILE);
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

/** Trades on a coin buffered from just before its launch was sent until the exit takes over. */
const early = new Map<string, { trades: LiveTrade[]; off: () => void }>();

/** The launch sequence's dependencies for this mode; `feed` is the live trade feed (null in fork runs). */
function baseDeps(venue: Venue, notifier: Notifier, feed: LiveFeed | null): LaunchDeps {
  return {
    venue,
    notifier,
    db,
    playbook,
    limits: smoke ? { ...DEFAULT_LIMITS, maxLaunchesPerDay: 3 } : DEFAULT_LIMITS,
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
    prewatch: (mint) => {
      if (!feed) return;
      const b = { trades: [] as LiveTrade[], off: () => {} };
      b.off = feed.subscribe(mint, venue.dev, (t) => void b.trades.push(t));
      early.set(mint, b);
    },
    watch: (mint, _landing, onTrade) => {
      if (!feed) return () => {};
      // Trades that arrived while the launch confirmed go first; switching subscriptions is synchronous, so none fall
      // between the two.
      const b = early.get(mint);
      early.delete(mint);
      b?.off();
      for (const t of b?.trades ?? []) onTrade(t);
      return feed.subscribe(mint, venue.dev, onTrade);
    },
    unwatch: (mint) => {
      early.get(mint)?.off();
      early.delete(mint);
    },
    pause: (reason) => {
      try {
        writeFileSync(KILL_FILE, `${new Date().toISOString()} ${reason}\n`);
      } catch (e) {
        // The sell must go on even if the kill file cannot be written.
        log.error('could not write the kill file', { err: (e as Error).message });
      }
    },
    resolvePending: async (launches, postId) => {
      const read = async (uri: string | null): Promise<string | null | undefined> => {
        if (!uri) return null;
        for (const url of candidateUrls(uri, config.ipfsGateways).slice(0, 3)) {
          try {
            const res = await fetch(url, { signal: AbortSignal.timeout(3_000) });
            if (res.ok) return parseMeta((await res.json()) as Record<string, unknown>).twitter;
          } catch {
            // the next gateway
          }
        }
        return undefined;
      };
      const links = await Promise.all(launches.map((l) => read(l.uri)));
      return {
        linked: links.filter((t) => typeof t === 'string' && t.includes(postId)).length,
        unknown: links.filter((t) => t === undefined).length,
      };
    },
    validateExit: (policy) => void new ExitEngine(policy, { landedAt: 0, slot: null }, ''),
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
  // Live launches use ground "pump" addresses, as pump.fun's site does; dry runs and smoke tests leave the pool alone.
  if (mode === 'live' && !smoke) deps.nextMint = () => takeVanity();
  if (smoke) deps.recordAs = 'smoke';
  let busy = false;
  process.on('unhandledRejection', (e) => {
    log.error('unhandled rejection', { err: (e as Error)?.message ?? String(e) });
    void tg.send(`Internal error (the launcher keeps running): ${(e as Error)?.message ?? String(e)}`);
  });
  // A bag left by an earlier run (a crash or restart between a launch and its sell) is sold before anything else.
  const leftover = await sellLeftoverBags(db, venue, tg, playbook, smoke ? { recordedAs: 'smoke' } : {});
  if (leftover.failed.length) await tg.send(`${leftover.failed.length} leftover bag(s) still held: launching is paused until they are sold.`);
  if (leftover.failed.length) writeFileSync(KILL_FILE, `leftover bags unsold at start: ${leftover.failed.join(', ')}\n`);
  const balance = await venue.balanceLamports().catch(() => null);
  await tg.send(
    (smoke ? 'SMOKE TEST: one 0.1 SOL launch to check everything end to end; use a separate test wallet.\n' : '') +
    `Launcher started in ${mode} mode, playbook v${PLAYBOOK.version}. Wallet ${venue.dev}: ` +
      `${balance === null ? 'balance unknown' : `${(Number(balance) / 1e9).toFixed(4)} SOL`}. ` +
      `Dev buy ${playbook.devBuySol} SOL; kill switch ${killed() ? 'ON' : 'off'}; ${vanityLeft()} "pump" mint addresses ` +
      `ground${vanityLeft() === 0 ? ' (run npm run grind: launches will use random addresses)' : ''}.\n\n${USAGE}`,
  );

  let inFlight: Promise<void> | null = null;
  const launch = async (post: PostInfo, draft: CoinDraft, narrative: string) => {
    if (busy || stopping) {
      await tg.send(`${stopping ? 'Shutting down' : 'Busy with a launch'}; $${draft.symbol} skipped.`);
      return;
    }
    busy = true;
    inFlight = (async () => {
      try {
        const r = await runLaunch(deps, post, draft, narrative);
        log.info('launch finished', { status: r.status, symbol: draft.symbol });
      } catch (e) {
        // Anything thrown after the launch could leave a bag: pause until the owner has looked.
        writeFileSync(KILL_FILE, `${new Date().toISOString()} launch of $${draft.symbol} stopped by an error\n`);
        await tg.send(`Launch of $${draft.symbol} stopped by an error: ${(e as Error).message}. Launching paused; check the wallet.`);
      } finally {
        busy = false;
      }
    })();
    await inFlight;
    inFlight = null;
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
        let { name, ticker } = c;
        if (!name || !ticker) {
          const auto = autoDraft(post.text);
          if (!auto) throw new Error('could not draft a ticker and name from the post: send /launch <post url> | <TICKER> | <Name>');
          name ||= auto.name;
          ticker ||= auto.symbol;
        }
        const draft = buildDraft(post, { name, ticker, sourceUrl: c.sourceUrl, description: c.description, image: m.image });
        await launch(post, draft, post.text ?? c.name);
      } catch (e) {
        const problems = e instanceof DesignError ? e.problems.join('; ') : (e as Error).message;
        await tg.send(`Cannot launch: ${problems}`);
      }
    }
  };

  // Posts from watched accounts become launch cards with a drafted name, ticker and the post's image.
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
      const pre = launchBoard({ playbook, limits: deps.limits, post, draft, state: boardState(db, post, draft.symbol, now(), { balanceLamports: await venue.balanceLamports().catch(() => null), killed: killed() }), compliance: checkCompliance(draft, post), preflight: null, approved: null }, 'before preflight');
      // Launches made seconds ago may not have their metadata yet; the launch sequence waits for it, so only a post
      // already taken, or another gate, drops the candidate here.
      const blocking = pre.gates.filter((g) => !g.pass && !(g.name === 'first on the post' && g.detail.startsWith('0 launches')));
      if (blocking.length) return;
      await launch(post, draft, `${c.text} (auto draft from ${d.basis})`);
    } catch (e) {
      log.warn('candidate skipped', { url: c.url, err: (e as Error).message });
    }
  };

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
  const stop = new AbortController();
  // A launch in flight finishes (its sell and its record) before the feed, Telegram and the database close.
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    watcher?.stop();
    void (async () => {
      if (inFlight) {
        await tg.send('Shutting down after the launch in progress finishes.');
        await inFlight;
      }
      stop.abort();
      feed.stop();
      tg.close();
    })();
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
