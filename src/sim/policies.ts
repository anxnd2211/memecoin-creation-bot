import type { ExitPolicy } from './simulate.ts';

/**
 * Selling plans the backtest compares. Each family is a grid; plans one step apart on one parameter are neighbours,
 * so a plan is chosen for doing well together with its neighbours rather than for one lucky spike.
 */

export interface GridPolicy extends ExitPolicy {
  family: string;
  /** Index of each parameter's value in its family grid. */
  at: number[];
}

/** The recorded dev's own trades, replayed: the benchmark every plan has to beat. */
export const RECORDED_DEV: ExitPolicy = {
  name: 'recorded dev (as they traded)',
  devBuySol: null,
  ladder: [],
  maxHoldSec: Infinity,
  idleSec: null,
  moonbagShare: 0,
  replayDev: true,
};

const TIME = { hold: [3, 5, 8, 10, 15, 20, 25, 30, 45, 60, 90, 120, 300], moonbag: [0, 0.1, 0.2, 0.35] };
const DUMP = { inflow: [0.01, 0.25, 0.5, 1, 2, 4, 8], hold: [5, 10, 15, 20, 30, 60, 120, 300], idle: [null, 3, 5, 10, 30] };
const LADDER = {
  base: [0.25, 0.5, 1, 2, 4, 8],
  hold: [10, 15, 20, 30, 60, 120, 300, 600],
  idle: [null, 3, 5, 10, 30],
  moonbag: [0, 0.1, 0.2, 0.35],
};
const LADDER_STEPS = [1, 2, 4, 8];

const idleName = (s: number | null) => (s === null ? '' : `, idle ${s}s`);

const moonbagName = (m: number) => (m ? `, moonbag ${Math.round(m * 100)}%` : '');

/** Holds the launch bag for a fixed time, then sells everything but the moonbag. */
export function timePolicy(holdSec: number, moonbagShare: number): ExitPolicy {
  return {
    name: `hold ${holdSec}s then sell${moonbagName(moonbagShare)}`,
    devBuySol: null,
    ladder: [],
    maxHoldSec: holdSec,
    idleSec: null,
    moonbagShare,
  };
}

export function dumpPolicy(inflowSol: number, maxHoldSec: number, idleSec: number | null): ExitPolicy {
  return {
    name: `dump at ${inflowSol} SOL in, hold <=${maxHoldSec}s${idleName(idleSec)}`,
    devBuySol: null,
    ladder: [{ inflowSol, share: 1 }],
    maxHoldSec,
    idleSec,
    moonbagShare: 0,
  };
}

/** Sells (1 - moonbag) / 4 of the launch bag as net inflow reaches base x 1, 2, 4 and 8 SOL. */
export function ladderPolicy(baseSol: number, maxHoldSec: number, idleSec: number | null, moonbagShare: number): ExitPolicy {
  const share = (1 - moonbagShare) / LADDER_STEPS.length;
  return {
    name:
      `ladder ${LADDER_STEPS.map((k) => k * baseSol).join('/')} SOL, hold <=${maxHoldSec}s${idleName(idleSec)}` +
      moonbagName(moonbagShare),
    devBuySol: null,
    ladder: LADDER_STEPS.map((k) => ({ inflowSol: k * baseSol, share })),
    maxHoldSec,
    idleSec,
    moonbagShare,
  };
}

/** Every combination of each family's parameter values. */
function product(sizes: number[]): number[][] {
  return sizes.reduce<number[][]>((acc, n) => acc.flatMap((a) => Array.from({ length: n }, (_, i) => [...a, i])), [[]]);
}

export function policyGrid(): GridPolicy[] {
  const out: GridPolicy[] = [];
  for (const at of product([TIME.hold.length, TIME.moonbag.length])) {
    out.push({ ...timePolicy(TIME.hold[at[0]!]!, TIME.moonbag[at[1]!]!), family: 'time', at });
  }
  for (const at of product([DUMP.inflow.length, DUMP.hold.length, DUMP.idle.length])) {
    const p = dumpPolicy(DUMP.inflow[at[0]!]!, DUMP.hold[at[1]!]!, DUMP.idle[at[2]!]!);
    out.push({ ...p, family: 'dump', at });
  }
  for (const at of product([LADDER.base.length, LADDER.hold.length, LADDER.idle.length, LADDER.moonbag.length])) {
    const p = ladderPolicy(LADDER.base[at[0]!]!, LADDER.hold[at[1]!]!, LADDER.idle[at[2]!]!, LADDER.moonbag[at[3]!]!);
    out.push({ ...p, family: 'ladder', at });
  }
  return out;
}

/** Plans in the same family one step away on exactly one parameter. */
export function neighbours(p: GridPolicy, all: GridPolicy[]): GridPolicy[] {
  return all.filter(
    (q) => q.family === p.family && q.at.reduce((d, v, i) => d + Math.abs(v - p.at[i]!), 0) === 1,
  );
}
