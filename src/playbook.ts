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
];

export const PLAYBOOK: Playbook = PLAYBOOKS.at(-1)!;

/** The exit to run given how far the trade feed is behind the chain (p95, seconds); unknown lag counts as slow. */
export function exitFor(p: Playbook, feedLagSec: number | null): ExitPolicy {
  return feedLagSec !== null && feedLagSec <= p.maxFeedLagSec ? p.exit : p.slowFeedExit;
}

/** Whether a recorded launch looks like one this playbook would make (dev buy band, links, post age and order). */
export function matchesPlaybook(p: Playbook, t: LaunchTraits): boolean {
  const r = p.require;
  const maxAge = r.maxPostAgeSec;
  return (
    p.devBuyBands.includes(t.devBuy) &&
    (r.xLink === null || t.xLink === 'tweet' || (r.xLink === 'any' && (t.xLink === 'community' || t.xLink === 'profile'))) &&
    (!r.website || t.website === 'yes') &&
    (maxAge === null || (t.postAge in POST_AGE_MAX_SEC && POST_AGE_MAX_SEC[t.postAge as keyof typeof POST_AGE_MAX_SEC] <= maxAge)) &&
    (!r.firstOnPost || t.postOrder === 'first') &&
    (!r.skipFarmedAccounts || t.sourceHeat === '0-2') &&
    (p.minGapBetweenLaunchesSec < 600 || t.devGap !== 'under 10m')
  );
}
