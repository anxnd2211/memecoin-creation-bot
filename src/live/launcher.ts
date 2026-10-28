import type { DatabaseSync } from 'node:sqlite';
import { Keypair } from '@solana/web3.js';
import { CURVE_FEE_RATE, LAUNCH_VIRTUAL_SOL as LAUNCH_VSOL } from '../chain/curve.ts';
import { exitFor, type Playbook } from '../playbook.ts';
import type { ExitPolicy } from '../sim/simulate.ts';
import { accountRecord, boardState, formatGates, launchBoard, pendingLaunchUris, type BoardState, type Limits } from './board.ts';
import { launchPnl, recordOutcome, recordPlan } from './dossier.ts';
import type { CoinDraft, ExitDecision, LaunchFill, LiveTrade, Notifier, PostInfo, SellFill, Venue } from './types.ts';
import { LAUNCH_RENT_ESTIMATE_LAMPORTS, LaunchFailedError, NotLandedError, NotSentError } from './venue.ts';
import { PreflightError } from './types.ts';
import { config } from '../config.ts';

/**
 * One launch, start to finish: board, preflight, approval, a last freshness check, the launch, the live exit, the
 * sell, and the record. Every step that cannot be completed stops the launch before any SOL moves; once the dev buy
 * has landed, the only goal is to sell the whole bag.
 */

/** What the launch sequence needs from the rest of the live launcher; the live command wires in the real ones. */
export interface LaunchDeps {
  venue: Venue;
  notifier: Notifier;
  db: DatabaseSync;
  playbook: Playbook;
  limits: Limits;
  /** Unix seconds now. */
  now: () => number;
  killed: () => boolean;
  /** The feed's lag behind the chain in seconds (p95), or null when unknown. */
  feedLag: () => number | null;
  checkCompliance: (draft: CoinDraft, post: PostInfo) => string[];
  /** Uploads the metadata and returns its URI (a placeholder in fork and dry runs). */
  uploadMetadata: (draft: CoinDraft) => Promise<string>;
  /**
   * Streams our coin's trades to `onTrade` until the returned function is called. In fork runs this replays a
   * recorded launch on the fork; live it is the trade feed.
   */
  watch: (mint: string, landing: LaunchFill, onTrade: (t: LiveTrade) => void) => () => void;
  /** The exit engine for a policy (src/live/exit.ts): fed trades and clock ticks, it says when to sell. */
  makeExit: (policy: ExitPolicy, landing: LaunchFill) => {
    onTrade(t: LiveTrade): ExitDecision | null;
    onTick(nowMs: number): ExitDecision | null;
    /** Sell now; returns the decision already made if there is one. */
    kill(nowMs: number): ExitDecision;
  };
  /**
   * Starts listening for the coin's trades before the launch is sent (the mint address is known in advance), so the
   * snipers' trades in the launch's first slots are not missed while the launch confirms; `watch` then replays them.
   */
  prewatch?: (mint: string) => void;
  /** Stops listening for a coin whose launch never happened (undoes `prewatch`). */
  unwatch?: (mint: string) => void;
  /**
   * Stops new launches (the kill switch) with a reason: after a launch whose outcome is unknown, or a bag that could
   * not be sold, nothing new goes out until the owner has looked.
   */
  pause?: (reason: string) => void;
  /**
   * Fetches the metadata of launches the observer has not fetched yet and says how many link `postId` and how many
   * could not be read; the board blocks on either.
   */
  resolvePending?: (launches: { mint: string; uri: string | null }[], postId: string) => Promise<{ linked: number; unknown: number }>;
  /** Throws if the exit engine cannot run this policy, checked before any SOL moves. */
  validateExit?: (policy: ExitPolicy) => void;
  /** The mode written to our_launches (default the venue's); smoke tests record as 'smoke', apart from real launches. */
  recordAs?: 'smoke';
  /** A mint keypair's secret key ending in "pump" (src/live/vanity.ts), or null for a random address. */
  nextMint?: () => Uint8Array | null;
  /** Seconds to wait for the owner's answer. */
  approvalTimeoutSec?: number;
  /** Milliseconds between exit-engine clock ticks. */
  tickMs?: number;
  /** Seconds after the sell to keep counting later buyers before the result is recorded. */
  settleSec?: number;
  /** Milliseconds between sell rounds after a failed sell (default 5000; the first retry waits a fifth of it). */
  retryDelayMs?: number;
}

export type LaunchResult =
  | { status: 'blocked'; stage: 'board' | 'preflight' | 'approval' | 'recheck' | 'metadata'; detail: string }
  | { status: 'failed'; stage: 'launch'; detail: string }
  | { status: 'launched'; fill: LaunchFill; sell: SellFill | null; exit: ExitDecision | null; pnlNote: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Virtual SOL at which the bag is sold before the curve completes (it completes at about 115). A completed curve moves
 * the coin to PumpSwap, where the bonding-curve sell no longer works.
 */
export const NEAR_GRADUATION_VSOL = 105;

/** How long the board waits for the observer to fetch the metadata of launches made seconds ago before fetching it. */
export const PENDING_WAIT_MS = 3_000;

/** Sell rounds before giving up and asking the owner to sell by hand; each round runs the venue's slippage ladder. */
export const SELL_ROUNDS = [
  // The first sell matters most (it lands into a dump): 1,000,000 micro-lamports on 150k units is 0.00015 SOL.
  { maxSlippage: 0.1, ladder: [0.2, 0.35], priorityMicroLamports: 1_000_000 },
  { maxSlippage: 0.35, ladder: [0.6], priorityMicroLamports: 1_000_000 },
  { maxSlippage: 0.6, ladder: [0.9], priorityMicroLamports: 5_000_000 },
  { maxSlippage: 0.9, ladder: [], priorityMicroLamports: 20_000_000 },
] as const;

/**
 * Sells the whole bag, round after round with wider limits and higher priority fees, until it is gone. After the
 * first failed round launching is paused and the owner is told; after the last, the owner must sell by hand.
 */
async function sellUntilGone(
  d: LaunchDeps,
  mint: string,
  symbol: string,
): Promise<{ sell: SellFill | null; gone: boolean; rounds: number; error: string | null }> {
  let error: string | null = null;
  for (let i = 0; i < SELL_ROUNDS.length; i++) {
    const r = SELL_ROUNDS[i]!;
    // The first round uses the playbook's limit; later rounds widen it.
    const maxSlippage = i === 0 ? d.playbook.sellMaxSlippage : r.maxSlippage;
    try {
      // Later rounds never pay less priority than the configured default.
      const priority = Math.max(config.priorityMicroLamports, r.priorityMicroLamports);
      const sell = await d.venue.sellAll(mint, { maxSlippage, ladder: [...r.ladder], priorityMicroLamports: priority });
      return { sell, gone: true, rounds: i + 1, error: null };
    } catch (e) {
      error = (e as Error).message;
      if (i === 0) {
        d.pause?.(`sell of ${mint} failed: ${error}`);
        void d.notifier.send(`Sell of $${symbol} failed (${error}). Launching paused; retrying with wider limits.`);
      }
      const left = await d.venue.tokenBalance(mint).catch(() => null);
      if (left === 0n) return { sell: null, gone: true, rounds: i + 1, error };
      const delay = d.retryDelayMs ?? 5_000;
      await sleep(i === 0 ? delay / 5 : delay);
    }
  }
  await d.notifier.send(
    `SELL OF $${symbol} FAILED after ${SELL_ROUNDS.length} rounds: ${error}. Sell ${mint} by hand now ` +
      `(on pump.fun; if the curve has completed, the coin trades on PumpSwap). Launching stays paused.`,
  );
  return { sell: null, gone: false, rounds: SELL_ROUNDS.length, error };
}

/** Drops the record of a launch that certainly created no coin, so it uses up no spacing or daily-limit room. */
function forget(d: LaunchDeps, mint: string): void {
  try {
    d.db.prepare('DELETE FROM our_launches WHERE mint = ? AND pnl_sol IS NULL').run(mint);
  } catch {
    // A record left behind only makes the gates stricter.
  }
}

/** The dev's tokens of `mint`, asked a few times; null when the RPC never answers. */
async function findBag(venue: Venue, mint: string, waitMs = 2_000, tries = 5): Promise<bigint | null> {
  for (let i = 0; i < tries; i++) {
    try {
      return await venue.tokenBalance(mint);
    } catch {
      await sleep(waitMs);
    }
  }
  return null;
}

/** An ipfs.io URI the length of a real one (a 59-character CIDv1), for the preflight before the upload finishes. */
const PLACEHOLDER_URI = `https://ipfs.io/ipfs/bafkrei${'a'.repeat(52)}`;

export async function runLaunch(d: LaunchDeps, post: PostInfo, draft: CoinDraft, narrative: string): Promise<LaunchResult> {
  const p = d.playbook;
  const balance = async () => {
    try {
      return await d.venue.balanceLamports();
    } catch {
      return null;
    }
  };
  /**
   * The board's state. Launches made in the last few seconds may not have their metadata yet, so whether one links
   * this post is unknown; the observer fetches it within seconds, so wait for it (up to `PENDING_WAIT_MS`) rather than
   * block on it.
   */
  const state = async (): Promise<BoardState> => {
    const until = Date.now() + PENDING_WAIT_MS;
    for (;;) {
      const s = boardState(d.db, post, draft.symbol, d.now(), { balanceLamports: await balance(), killed: d.killed() });
      if (!s.pendingLaunches || s.postLaunches) return s;
      if (Date.now() >= until) {
        // Still waiting on the observer: read those launches' metadata directly.
        if (!d.resolvePending) return s;
        const r = await d.resolvePending(pendingLaunchUris(d.db, post, d.now()), post.postId).catch(() => null);
        return r && s.postLaunches !== null ? { ...s, postLaunches: s.postLaunches + r.linked, pendingLaunches: r.unknown } : s;
      }
      await sleep(500);
    }
  };
  const compliance = d.checkCompliance(draft, post);

  // 1. The board, before simulating or bothering the owner.
  const first = launchBoard({ playbook: p, limits: d.limits, post, draft, state: await state(), compliance, preflight: null, approved: null }, 'before preflight');
  if (!first.pass) {
    await d.notifier.send(`Launch of $${draft.symbol} blocked:\n${formatGates(first.gates.filter((g) => !g.pass))}`);
    return { status: 'blocked', stage: 'board', detail: formatGates(first.gates) };
  }

  // 2. The metadata upload starts now and runs while the owner looks at the card; the preflight simulates the launch
  // with a placeholder URI of the same length (the launch itself is simulated again, with the real URI, before it is
  // sent).
  const upload = d.uploadMetadata(draft).then(
    (uri) => ({ uri, error: null as string | null }),
    (e: Error) => ({ uri: null as string | null, error: e.message }),
  );
  let mintKey = Keypair.generate();
  const params = { name: draft.name, symbol: draft.symbol, uri: PLACEHOLDER_URI, devBuySol: p.devBuySol, mintSecret: mintKey.secretKey };
  let preflight: string;
  try {
    await d.venue.preflightLaunch(params);
    preflight = 'ok';
  } catch (e) {
    preflight = (e as Error).message;
  }
  if (preflight !== 'ok') {
    await d.notifier.send(`Launch of $${draft.symbol} blocked: the simulation failed: ${preflight}`);
    return { status: 'blocked', stage: 'preflight', detail: preflight };
  }

  // 3. The owner's approval, with every gate on the card.
  const lag = d.feedLag();
  const policy = exitFor(p, lag);
  try {
    d.validateExit?.(policy);
    d.validateExit?.(p.exit);
    d.validateExit?.(p.slowFeedExit);
  } catch (e) {
    await d.notifier.send(`Launch of $${draft.symbol} blocked: the exit cannot run: ${(e as Error).message}`);
    return { status: 'blocked', stage: 'preflight', detail: (e as Error).message };
  }
  const card = launchBoard({ playbook: p, limits: d.limits, post, draft, state: await state(), compliance, preflight, approved: true });
  const rec = accountRecord(d.db, post.handle);
  const answer = await d.notifier.askApproval({
    text:
      `Launch $${draft.symbol} "${draft.name}"? (${d.venue.mode})\n` +
      `Post: ${post.url} (${Math.round(d.now() - post.postedAt)} s old)\nWebsite: ${draft.website}\n` +
      (rec ? `@${post.handle} so far: ${rec.launches} launches on ${rec.posts} posts, ${rec.busy} drew buyers\n` : '') +
      `Dev buy ${p.devBuySol} SOL; exit: ${policy.name}; feed lag ${lag === null ? 'unknown' : `${lag.toFixed(1)} s`}\n\n` +
      formatGates(card.gates.filter((g) => g.name !== 'owner approval')),
    image: draft.image.bytes,
    timeoutSec: d.approvalTimeoutSec ?? 30,
  });
  if (!answer.approved) return { status: 'blocked', stage: 'approval', detail: answer.by };
  const uploaded = await upload;
  if (!uploaded.uri) {
    await d.notifier.send(`Launch of $${draft.symbol} blocked: metadata upload failed: ${uploaded.error}`);
    return { status: 'blocked', stage: 'metadata', detail: uploaded.error ?? 'no URI' };
  }
  params.uri = uploaded.uri;

  // 4. The world may have moved while the owner looked: check the board again, approval included.
  const final = launchBoard({ playbook: p, limits: d.limits, post, draft, state: await state(), compliance, preflight, approved: true });
  if (!final.pass) {
    await d.notifier.send(`Approved, but $${draft.symbol} no longer passes:\n${formatGates(final.gates.filter((g) => !g.pass))}`);
    return { status: 'blocked', stage: 'recheck', detail: formatGates(final.gates) };
  }

  // 5. Launch. A ground "pump" address is taken only now, so a blocked launch does not use one up (the launch is
  // simulated again with it before it is sent). The record is written first, so a crash mid-launch still leaves it.
  const vanity = d.nextMint?.() ?? null;
  if (vanity) {
    mintKey = Keypair.fromSecretKey(vanity);
    params.mintSecret = mintKey.secretKey;
  }
  const mint = mintKey.publicKey.toBase58();
  recordPlan(d.db, {
    mint,
    mode: d.recordAs ?? d.venue.mode,
    createdTs: d.now(),
    playbook: p,
    post,
    narrative,
    postAgeSec: d.now() - post.postedAt,
    firstOnPost: true,
    exitPlan: policy.name,
    feedLagSec: lag,
  });
  // Creator fees are counted as the vault's growth over the launch; if it cannot be read now, none are counted, so a
  // failed read never books other coins' fees as this launch's profit.
  const vaultBefore = await d.venue.creatorVaultLamports().catch(() => null);
  // The wallet's balance around the whole launch is the ground truth for its result, whatever the RPC reported.
  const walletBefore = await d.venue.balanceLamports().catch(() => null);
  d.prewatch?.(mint);
  let fill: LaunchFill;
  let recovered = false;
  try {
    fill = await d.venue.launch(params);
  } catch (e) {
    const err = e as Error;
    // Failures before anything was sent, or a launch that landed and failed, created no coin.
    // A fork or dry venue never sends anything to mainnet, so its errors leave no real bag either.
    if (d.venue.mode !== 'live' || err instanceof NotSentError || err instanceof PreflightError || err instanceof LaunchFailedError) {
      d.unwatch?.(mint);
      forget(d, mint);
      void d.notifier.send(`Launch of $${draft.symbol} failed, no coin was created: ${err.message}`);
      return { status: 'failed', stage: 'launch', detail: err.message };
    }
    // Anything else may have landed, even a "not landed" verdict reached through a failing RPC: look for the bag on
    // two reads a few seconds apart before believing there is none.
    const certain = err instanceof NotLandedError && !err.uncertain;
    if (!certain) {
      d.pause?.(`launch of ${mint} ended uncertain: ${err.message}`);
      void d.notifier.send(`Launch of $${draft.symbol} (${mint}) ended uncertain (${err.message}). Launching paused; checking for the bag.`);
    }
    const wait = (d.retryDelayMs ?? 5_000) / 2.5;
    const first = await findBag(d.venue, mint, wait);
    const held = first === 0n ? (await sleep(wait), await findBag(d.venue, mint, wait)) : first;
    if (held === 0n) {
      d.unwatch?.(mint);
      if (certain) forget(d, mint);
      void d.notifier.send(
        certain
          ? `Launch of $${draft.symbol} did not land: ${err.message}`
          : `No bag found yet for ${mint}; check the wallet. Launching stays paused until /resume.`,
      );
      return { status: 'failed', stage: 'launch', detail: err.message };
    }
    if (certain) {
      d.pause?.(`launch of ${mint} reported not landed, but a bag is there`);
      void d.notifier.send(`Launch of $${draft.symbol} was reported not landed, but the bag is there: selling it. Launching paused.`);
    }
    recovered = true;
    fill = {
      mint,
      signature: 'unknown',
      slot: null,
      landedAt: Date.now(),
      devTokens: held ?? 0n,
      lamportsSpent: BigInt(Math.round(p.devBuySol * 1e9)),
      rentLamports: LAUNCH_RENT_ESTIMATE_LAMPORTS,
      networkFeeLamports: 0n,
      simulated: false,
    };
  }
  if (!recovered) void d.notifier.send(`Launched $${draft.symbol}: ${fill.mint} (${fill.signature}). Exit: ${policy.name}`);

  // 6. The exit: trades and clock ticks into the engine until it says sell, then the whole bag in one sell.
  const engine = d.makeExit(policy, fill);
  let decision: ExitDecision | null = null;
  const laterBuyers = new Set<string>();
  let sold = false;
  // The curve's virtual SOL, from our buy and everyone's trades since (SOL into the curve is the trade's SOL less fees).
  let vSol = LAUNCH_VSOL + Number(fill.lamportsSpent) / 1e9 / (1 + CURVE_FEE_RATE);
  const stopWatching = d.watch(mint, fill, (t) => {
    if (t.isBuy && !t.dev && t.receivedAt - fill.landedAt > 2_000) laterBuyers.add(t.wallet);
    if (!t.dev) vSol += t.isBuy ? t.sol / (1 + CURVE_FEE_RATE) : -t.sol / (1 - CURVE_FEE_RATE);
    if (!decision && !sold) {
      decision = engine.onTrade(t);
      if (!decision && vSol >= NEAR_GRADUATION_VSOL) {
        decision = { reason: 'near graduation', at: Date.now(), ageSec: (Date.now() - fill.landedAt) / 1000 };
      }
    }
  });
  const tickMs = d.tickMs ?? 200;
  if (recovered) decision = { reason: 'recovery', at: Date.now(), ageSec: 0 };
  while (!decision) {
    if (d.killed()) {
      decision = engine.kill(Date.now());
      break;
    }
    decision = engine.onTick(Date.now());
    if (!decision) await sleep(tickMs);
  }
  const result = await sellUntilGone(d, mint, draft.symbol);
  const sell = result.sell;
  if (sell) sold = true;
  const note = sell
    ? `sold on ${decision!.reason} at ${decision!.ageSec.toFixed(1)} s in ${sell.attempts} attempt(s)${result.rounds > 1 ? ` over ${result.rounds} rounds` : ''}`
    : result.gone
      ? `bag gone (sold by a retry whose fill is unknown) after ${decision!.reason}`
      : `SELL FAILED: ${result.error}`;

  // 7. Keep counting later buyers for a while, then record the result.
  await sleep((d.settleSec ?? 30) * 1000);
  stopWatching();
  const vaultAfter = vaultBefore === null ? null : await d.venue.creatorVaultLamports().catch(() => null);
  const walletAfter = walletBefore === null ? null : await d.venue.balanceLamports().catch(() => null);
  const outcome = {
    launch: fill,
    sell,
    exit: decision,
    vaultBefore: vaultBefore ?? 0n,
    vaultAfter: vaultAfter ?? vaultBefore ?? 0n,
    walletDeltaLamports: walletBefore !== null && walletAfter !== null ? walletAfter - walletBefore : null,
    laterBuyers: laterBuyers.size,
    note,
  };
  recordOutcome(d.db, mint, outcome);
  const pnl = launchPnl(outcome);
  await d.notifier.send(
    `$${draft.symbol}: ${note}. Result ${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)} SOL${fill.simulated ? ' (simulated: nothing was sent)' : ''}; ` +
      `${laterBuyers.size} later buyers.`,
  );
  return { status: 'launched', fill, sell, exit: decision, pnlNote: note };
}
