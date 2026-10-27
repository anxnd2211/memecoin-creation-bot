import assert from 'node:assert/strict';
import { test } from 'node:test';
import { curveSellValue } from '../src/chain/curve.ts';
import { analyseCoin, isSingleWalletClean, type CoinInfo, type TradeRow } from '../src/intel/devs.ts';

const T0 = 1_800_000_000;
const LAUNCH_PRICE = 30 / 1_073_000_000;

function info(o: Partial<CoinInfo> = {}): CoinInfo {
  return {
    mint: 'M',
    symbol: 'TEST',
    name: 'Test',
    creator: 'Creator',
    launcher: 'Launcher',
    createdTs: T0,
    launchMcapSol: LAUNCH_PRICE * 1e9,
    lastPriceSol: LAUNCH_PRICE,
    peakMcapSol: 60,
    peakTs: T0 + 29,
    graduatedTs: null,
    volumeSol: 10,
    isMayhem: false,
    creatorFeesSol: 0.03,
    socials: null,
    ...o,
  };
}

const tr = (wallet: number, ts: number, slot: number, isBuy: boolean, sol: number, coins: number, mcap: number | null = null): TradeRow => ({
  ts,
  slot,
  wallet,
  isBuy,
  sol,
  coins,
  mcap,
});

test('selling into a standard curve returns constant-product proceeds after fees', () => {
  assert.equal(curveSellValue(LAUNCH_PRICE, 0), 0);
  // 30 - 32.19e9 / (1.073e9 + 1e8) = 2.5575 SOL before the 1.25% fee.
  assert.ok(Math.abs(curveSellValue(LAUNCH_PRICE, 100_000_000) - 2.5575 * 0.9875) < 1e-3);
});

test('the launch signer counts as the dev, and wallets moving with it are found', () => {
  const LAUNCHER = 2;
  const trades = [
    tr(LAUNCHER, T0, 100, true, 1, 34_000_000),
    tr(3, T0, 100, true, 0.5, 16_000_000), // same slot as the launch
    tr(4, T0 + 1, 101, true, 0.3, 9_000_000), // launch-window sniper
    ...Array.from({ length: 12 }, (_, i) => tr(10 + i, T0 + 10 + i, 110 + i, true, 0.2, 5_000_000, 40)),
    tr(LAUNCHER, T0 + 30, 140, false, 2.5, 34_000_000, 50),
    tr(3, T0 + 30, 141, false, 0.9, 16_000_000, 45), // sells with the dev
    tr(4, T0 + 90, 300, false, 0.2, 9_000_000, 30),
  ];
  const c = analyseCoin(info(), trades, new Set([1, LAUNCHER]));

  assert.equal(c.devBuySol, 1);
  assert.equal(c.devSellSol, 2.5);
  assert.equal(c.devBagSol, 0);
  assert.ok(Math.abs(c.devTotalPnl - 1.53) < 1e-9);
  assert.equal(c.style, 'single_dump');
  assert.equal(c.firstSell!.ageSec, 30);
  assert.equal(c.firstSell!.buyersBefore, 14);
  assert.ok(Math.abs(c.firstSell!.buySolBefore - 3.2) < 1e-9);
  assert.equal(c.firstSell!.sinceLastBuySec, 9);
  assert.ok(Math.abs(c.firstSell!.mcapMultiple! - 40 / (LAUNCH_PRICE * 1e9)) < 1e-9);
  assert.equal(c.sameSlotBuyers, 1);
  assert.equal(c.earlyBuyers, 2);
  assert.equal(c.coordinatedSellers, 1);
  assert.equal(c.bundleLike, false);
  assert.equal(c.organicBuyers, 12);
  assert.equal(c.active, true);
  // Dev result plus the same-slot wallet's +0.4 SOL; the sniper's -0.1 is not part of the cluster.
  assert.ok(Math.abs(c.clusterPnl - 1.93) < 1e-9);
});

test('a dev still holding is valued at what the bag would fetch, except on graduated coins', () => {
  const trades = [tr(1, T0, 100, true, 1, 34_000_000)];
  const live = analyseCoin(info({ lastPriceSol: LAUNCH_PRICE * 2 }), trades, new Set([1]));
  assert.equal(live.style, 'holding');
  assert.ok(live.devBagSol > 0 && live.devBagSol < 34_000_000 * LAUNCH_PRICE * 2);

  const grad = analyseCoin(info({ lastPriceSol: LAUNCH_PRICE * 50, graduatedTs: T0 + 600 }), trades, new Set([1]));
  assert.equal(grad.devBagSol, 0);
  assert.ok(grad.devGraduatedBagSol > 0);
  assert.ok(Math.abs(grad.devTotalPnl - (-1 + 0.03)) < 1e-9);
});

test('the Mayhem agent is reported apart and never counts as an organic buyer', () => {
  const AGENT = 99;
  const trades = [
    tr(1, T0, 100, true, 1, 34_000_000),
    tr(AGENT, T0 + 5, 110, true, 4, 90_000_000, 60),
    tr(5, T0 + 6, 111, true, 0.3, 5_000_000, 62),
    tr(1, T0 + 8, 120, false, 2.9, 34_000_000, 40),
    tr(AGENT, T0 + 20, 150, false, 1.5, 120_000_000, 20), // sells more than it bought: minted supply
  ];
  const c = analyseCoin(info({ isMayhem: true }), trades, new Set([1]), new Set([AGENT]));
  assert.equal(c.organicBuyers, 1);
  assert.equal(c.agentBuySolBeforeSell, 4);
  assert.equal(c.agentNetSol, -2.5);
  assert.equal(c.transferSellers, 0);
  assert.ok(c.wallets.every((w) => w.wallet !== AGENT));
});

test('a dev selling tokens other wallets bought is not single-wallet clean', () => {
  const trades = [
    tr(1, T0, 100, true, 0.5, 17_000_000),
    tr(7, T0 + 4, 110, true, 3, 80_000_000, 45), // buys, then passes its tokens to the dev
    tr(1, T0 + 9, 125, false, 3.3, 97_000_000, 30),
  ];
  const c = analyseCoin(info({ launcher: 'Creator' }), trades, new Set([1]));
  assert.equal(c.bundleLike, false);
  assert.equal(c.devSoldUnbought, true);
  assert.equal(isSingleWalletClean(c), false);
  const honest = analyseCoin(info({ launcher: 'Creator' }), trades.slice(0, 2).concat(tr(1, T0 + 9, 125, false, 0.6, 17_000_000, 40)), new Set([1]));
  assert.equal(isSingleWalletClean(honest), true);
});

test('known sniper bots in the launch slot are not counted as the dev\'s wallets', () => {
  const trades = [
    tr(1, T0, 100, true, 1, 34_000_000),
    tr(3, T0, 100, true, 0.5, 16_000_000),
    tr(4, T0, 100, true, 0.5, 15_000_000),
    tr(1, T0 + 5, 120, false, 1.4, 34_000_000, 40),
    tr(3, T0 + 5, 121, false, 0.7, 16_000_000, 35),
    tr(4, T0 + 5, 121, false, 0.6, 15_000_000, 30),
  ];
  assert.equal(analyseCoin(info(), trades, new Set([1])).bundleLike, true);
  const c = analyseCoin(info(), trades, new Set([1]), new Set(), new Set([3, 4]));
  assert.equal(c.bundleLike, false);
  assert.equal(c.sameSlotBuyers, 0);
  assert.equal(c.coordinatedSellers, 0);
});
