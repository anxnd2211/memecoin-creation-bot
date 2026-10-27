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
const FLOW = { minHold: [0, 5, 10, 20, 30], window: [3, 5, 10, 20], minSol: [0, 0.5, 1], hold: [60, 120, 300], moonbag: [0, 0.1] };
const LADDER_STEPS = [1, 2, 4, 8];
const SPLIT = { startSec: [3, 5, 8, 10, 15], stepSec: [0.5, 1, 2, 4], parts: [2, 4] };
const FLOW_MOON = {
  minHold: [5, 10, 20],
  window: [5, 10, 20],
  moonbag: [0.25, 0.5],
  window2: [15, 30, 60],
  hold2: [300, 600],
};

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

/** Holds while other wallets keep buying; sells everything once their net buying over a short window stalls. */
export function flowPolicy(minHoldSec: number, windowSec: number, minSol: number, maxHoldSec: number, moonbagShare: number): ExitPolicy {
  return {
    name:
      `hold ${minHoldSec}s+, sell when ${windowSec}s net buying <= ${minSol} SOL, hold <=${maxHoldSec}s` +
      moonbagName(moonbagShare),
    devBuySol: null,
    ladder: [],
    maxHoldSec,
    idleSec: null,
    stall: { minHoldSec, windowSec, minSol },
    moonbagShare,
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

/** Sells the launch bag in equal parts at fixed times: the quick split most profitable devs use. */
export function splitPolicy(startSec: number, stepSec: number, parts: number): ExitPolicy {
  const times = Array.from({ length: parts }, (_, i) => startSec + i * stepSec);
  return {
    name: `split in ${parts} at ${times.join('/')}s`,
    devBuySol: null,
    ladder: [],
    timeLadder: times.map((atSec) => ({ atSec, share: 1 / parts })),
    maxHoldSec: times.at(-1)!,
    idleSec: null,
    moonbagShare: 0,
  };
}

/**
 * The flow exit for most of the bag, then the moonbag sold once buying stalls again over a longer window: devs that
 * kept part of the bag and sold it in later tranches.
 */
export function flowMoonPolicy(
  minHoldSec: number,
  windowSec: number,
  moonbagShare: number,
  window2Sec: number,
  hold2Sec: number,
): ExitPolicy {
  return {
    ...flowPolicy(minHoldSec, windowSec, 0.5, 120, moonbagShare),
    name:
      `hold ${minHoldSec}s+, sell ${Math.round((1 - moonbagShare) * 100)}% when ${windowSec}s net buying <= 0.5 SOL, ` +
      `rest when ${window2Sec}s net buying <= 0 or at ${hold2Sec}s`,
    moonbagExit: { windowSec: window2Sec, minSol: 0, maxHoldSec: hold2Sec },
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
  for (const at of product([FLOW.minHold.length, FLOW.window.length, FLOW.minSol.length, FLOW.hold.length, FLOW.moonbag.length])) {
    const p = flowPolicy(FLOW.minHold[at[0]!]!, FLOW.window[at[1]!]!, FLOW.minSol[at[2]!]!, FLOW.hold[at[3]!]!, FLOW.moonbag[at[4]!]!);
    out.push({ ...p, family: 'flow', at });
  }
  for (const at of product([SPLIT.startSec.length, SPLIT.stepSec.length, SPLIT.parts.length])) {
    const p = splitPolicy(SPLIT.startSec[at[0]!]!, SPLIT.stepSec[at[1]!]!, SPLIT.parts[at[2]!]!);
    out.push({ ...p, family: 'split', at });
  }
  for (const at of product([
    FLOW_MOON.minHold.length,
    FLOW_MOON.window.length,
    FLOW_MOON.moonbag.length,
    FLOW_MOON.window2.length,
    FLOW_MOON.hold2.length,
  ])) {
    const p = flowMoonPolicy(
      FLOW_MOON.minHold[at[0]!]!,
      FLOW_MOON.window[at[1]!]!,
      FLOW_MOON.moonbag[at[2]!]!,
      FLOW_MOON.window2[at[3]!]!,
      FLOW_MOON.hold2[at[4]!]!,
    );
    out.push({ ...p, family: 'flow+moonbag', at });
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
