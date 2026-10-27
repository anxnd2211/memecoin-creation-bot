import { flowPolicy, timePolicy } from './sim/policies.ts';
import type { ExitPolicy } from './sim/simulate.ts';
import type { LaunchTraits } from './sim/traits.ts';

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
  /** SOL spent in the create transaction, fees included (3 SOL into the curve). */
  devBuySol: number;
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
  require: { xLink: 'tweet' | 'any' | null; website: boolean };
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
    exit: timePolicy(20, 0),
    slowFeedExit: timePolicy(20, 0),
    maxFeedLagSec: Infinity,
    require: { xLink: null, website: false },
    pauseAfterDeadInARow: Infinity,
  },
  {
    version: 1,
    adopted: '2026-10-27',
    mayhem: false,
    devBuySol: 3.0375,
    exit: flowPolicy(10, 10, 0.5, 120, 0),
    slowFeedExit: timePolicy(20, 0),
    maxFeedLagSec: 2,
    require: { xLink: 'tweet', website: true },
    pauseAfterDeadInARow: 3,
  },
];

export const PLAYBOOK: Playbook = PLAYBOOKS.at(-1)!;

/** The exit to run given how far the trade feed is behind the chain (p95, seconds); unknown lag counts as slow. */
export function exitFor(p: Playbook, feedLagSec: number | null): ExitPolicy {
  return feedLagSec !== null && feedLagSec <= p.maxFeedLagSec ? p.exit : p.slowFeedExit;
}

/** Whether a recorded launch looks like one this playbook would make (dev buy band and required links). */
export function matchesPlaybook(p: Playbook, t: LaunchTraits): boolean {
  return (
    t.devBuy === '2.95-4.5' &&
    (p.require.xLink === null ||
      t.xLink === 'tweet' ||
      (p.require.xLink === 'any' && (t.xLink === 'community' || t.xLink === 'profile'))) &&
    (!p.require.website || t.website === 'yes')
  );
}
