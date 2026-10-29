import { flowPolicy, timePolicy } from './sim/policies.ts';
import type { ExitPolicy } from './sim/simulate.ts';
import { POST_AGE_MAX_SEC, type LaunchTraits } from './sim/traits.ts';

/**
 * The launch playbook: how the bot launches and sells, versioned. A new version replaces the current one only when it
 * beats it on launches held out from its choice by more than the noise (npm run simulate -- --folds), and the owner
 * approves. Every launch records the version it used. The reasoning and evidence for each version are in
 * docs/PLAYBOOK.md.
 */

export interface Playbook {
  version: number;
  adopted: string;
  /** Normal mode only: in Mayhem mode pump.fun's agent sells minted supply, which breaks the dev's loss bound. */
  mayhem: false;
  /** SOL spent in the create transaction, fees included (5 SOL into the curve from v2). */
  devBuySol: number;
  /** Dev-buy bands (`devBuyBand`) a recorded launch must fall in to count as one this playbook would make. */
  devBuyBands: string[];
  exit: ExitPolicy;
  /**
   * The exit to use instead while the trade feed runs more than `maxFeedLagSec` behind the chain: an exit that reacts
   * to trades loses its edge after about 2 seconds of lag, while a timed exit does not depend on the feed.
   */
  slowFeedExit: ExitPolicy;
  maxFeedLagSec: number;
  /**
   * What every launch must have; the launch board blocks a launch without it. `xLink: 'tweet'` means a link to the
   * post the narrative came from, not a profile; `website` is the narrative's original source (article, video, site).
   */
  require: {
    xLink: 'tweet' | 'any' | null;
    website: boolean;
    /** Launch only while the linked post is at most this old; null for no limit. */
    maxPostAgeSec: number | null;
    /** Launch only if no other launch has linked the same post yet. */
    firstOnPost: boolean;
    /**
     * With `firstOnPost`, how many earlier launches on the post are allowed: 0 normally; the launch-follower sets 1,
     * since the first launch on a post is how it finds the post (later ones made +1.1 SOL at a 2 SOL bag).
     */
    maxPriorLaunchesOnPost?: number;
    /** Skip posts by an X account that 3 or more launches linked in the hour before (farmed accounts draw less). */
    skipFarmedAccounts: boolean;
  };
  /** Seconds to wait after our previous launch: snipers put less into a dev launching again within 10 minutes. */
  minGapBetweenLaunchesSec: number;
  /**
   * Most the whole-bag sell may fetch below its quote before it fails and is re-quoted and re-sent. 99% of sells moved
   * less than 8.2% between the decision and landing; the limit also caps what a sandwich could take.
   */
  sellMaxSlippage: number;
  /**
   * Stop launching for a review after this many launches in a row draw no buyers: devs whose earlier launches all died
   * drew buyers 7% of the time, against 41% for devs with an earlier busy launch, and our one wallet keeps its history.
   * v4 raised it to 6 on a simulation that treated launches as independent; v5 put it back at 3, because each dead
   * launch lowers the next one's chances (44% drew buyers from a new wallet, 6% after 3+ dead launches).
   */
  pauseAfterDeadInARow: number;
}

export const PLAYBOOKS: Playbook[] = [
  {
    version: 0,
    adopted: '2026-10-27',
    mayhem: false,
    devBuySol: 3.0375,
    devBuyBands: ['2.95-3.05', '3.05-4.9'],
    exit: timePolicy(20, 0),
    slowFeedExit: timePolicy(20, 0),
    maxFeedLagSec: Infinity,
    require: { xLink: null, website: false, maxPostAgeSec: null, firstOnPost: false, skipFarmedAccounts: false },
    minGapBetweenLaunchesSec: 0,
    sellMaxSlippage: 0.1,
    pauseAfterDeadInARow: Infinity,
  },
  {
    version: 1,
    adopted: '2026-10-27',
    mayhem: false,
    devBuySol: 3.0375,
    devBuyBands: ['2.95-3.05', '3.05-4.9'],
    exit: flowPolicy(10, 10, 0.5, 120, 0),
    slowFeedExit: timePolicy(20, 0),
    maxFeedLagSec: 2,
    require: { xLink: 'tweet', website: true, maxPostAgeSec: null, firstOnPost: false, skipFarmedAccounts: false },
    minGapBetweenLaunchesSec: 0,
    sellMaxSlippage: 0.1,
    pauseAfterDeadInARow: 3,
  },
  {
    version: 2,
    adopted: '2026-10-28',
    mayhem: false,
    devBuySol: 5.0625,
    devBuyBands: ['4.9-5.1'],
    exit: flowPolicy(10, 5, 0.5, 120, 0),
    slowFeedExit: timePolicy(20, 0),
    maxFeedLagSec: 2,
    require: { xLink: 'tweet', website: false, maxPostAgeSec: 120, firstOnPost: true, skipFarmedAccounts: false },
    minGapBetweenLaunchesSec: 0,
    sellMaxSlippage: 0.1,
    pauseAfterDeadInARow: 3,
  },
  {
    version: 3,
    adopted: '2026-10-28',
    mayhem: false,
    devBuySol: 5.0625,
    devBuyBands: ['4.9-5.1'],
    exit: flowPolicy(10, 5, 0.5, 120, 0),
    slowFeedExit: timePolicy(15, 0),
    maxFeedLagSec: 3,
    require: { xLink: 'tweet', website: true, maxPostAgeSec: 120, firstOnPost: true, skipFarmedAccounts: true },
    minGapBetweenLaunchesSec: 600,
    sellMaxSlippage: 0.1,
    pauseAfterDeadInARow: 3,
  },
  // v4 (2026-10-29), after the first live batch: v3's rules, with the pause at 6 dead launches in a row. With fake
  // demand (copy launches, create-slot bundles) left out, a first launch draws buyers about 1 time in 3, so 3 dead in a
  // row is routine (about 30% by chance) and pausing there stops healthy sessions: on a 2.43 SOL wallet at half the
  // recorded hit rate, pausing at 3 gave +1.51 SOL a 10-launch session and a 22% chance of ending down, pausing at 6
  // gave +2.89 and 9% (ml/followgate.py). Six in a row happens by chance about 9% of the time, so it still flags a
  // broken launch path, at about 0.33 SOL of dead 2 SOL launches.
  {
    version: 4,
    adopted: '2026-10-29',
    mayhem: false,
    devBuySol: 5.0625,
    devBuyBands: ['4.9-5.1'],
    exit: flowPolicy(10, 5, 0.5, 120, 0),
    slowFeedExit: timePolicy(15, 0),
    maxFeedLagSec: 3,
    require: { xLink: 'tweet', website: true, maxPostAgeSec: 120, firstOnPost: true, skipFarmedAccounts: true },
    minGapBetweenLaunchesSec: 600,
    sellMaxSlippage: 0.1,
    pauseAfterDeadInARow: 6,
  },
  // v5 (2026-10-29), after the second live session: v4 with the pause back at 3. v4's simulation treated launches as
  // independent; they are not. A dev wallet's dead launches poison its next ones: single-wallet, real-demand launches
  // with a 1.9+ SOL dev buy drew buyers 44% of the time from a wallet with no earlier launch, 14% after 1-2 dead ones,
  // 6% after 3+ dead ones, and 53% after an earlier busy one. Our launch wallet drew no sniper buy on any of its last
  // four launches, including a first launch 17 s after a @Daily_MailUS post. Stopping early protects the record.
  {
    version: 5,
    adopted: '2026-10-29',
    mayhem: false,
    devBuySol: 5.0625,
    devBuyBands: ['4.9-5.1'],
    exit: flowPolicy(10, 5, 0.5, 120, 0),
    slowFeedExit: timePolicy(15, 0),
    maxFeedLagSec: 3,
    require: { xLink: 'tweet', website: true, maxPostAgeSec: 120, firstOnPost: true, skipFarmedAccounts: true },
    minGapBetweenLaunchesSec: 600,
    sellMaxSlippage: 0.1,
    pauseAfterDeadInARow: 3,
  },
];

export const PLAYBOOK: Playbook = PLAYBOOKS.at(-1)!;

/** The exit to run given how far the trade feed is behind the chain (p95, seconds); unknown lag counts as slow. */
export function exitFor(p: Playbook, feedLagSec: number | null): ExitPolicy {
  return feedLagSec !== null && feedLagSec <= p.maxFeedLagSec ? p.exit : p.slowFeedExit;
}

/** Whether a recorded launch looks like one this playbook would make (dev buy band, links, post age and order). */
/** Whether a recorded launch follows the playbook's rules; `anyDevBuy` drops the dev-buy band (the caller matches size). */
export function matchesPlaybook(p: Playbook, t: LaunchTraits, anyDevBuy = false): boolean {
  const r = p.require;
  const maxAge = r.maxPostAgeSec;
  return (
    (anyDevBuy || p.devBuyBands.includes(t.devBuy)) &&
    (r.xLink === null || t.xLink === 'tweet' || (r.xLink === 'any' && (t.xLink === 'community' || t.xLink === 'profile'))) &&
    (!r.website || t.website === 'yes') &&
    (maxAge === null || (t.postAge in POST_AGE_MAX_SEC && POST_AGE_MAX_SEC[t.postAge as keyof typeof POST_AGE_MAX_SEC] <= maxAge)) &&
    (!r.firstOnPost || t.postOrder === 'first') &&
    (!r.skipFarmedAccounts || t.sourceHeat === '0-2') &&
    (p.minGapBetweenLaunchesSec < 600 || t.devGap !== 'under 10m')
  );
}
