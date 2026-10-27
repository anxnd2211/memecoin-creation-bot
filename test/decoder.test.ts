import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { PayloadDeduper, decodeTx, extractProgramData } from '../src/chain/decoder.ts';
import type { RawTx } from '../src/chain/events.ts';

// Real mainnet transactions captured from the live stream, with the events decoded at capture time.
const fixtures = JSON.parse(readFileSync(new URL('./fixtures/live-txs.json', import.meta.url), 'utf8')) as Record<
  string,
  { tx: RawTx; event: Record<string, unknown> }
>;

for (const [name, { tx, event }] of Object.entries(fixtures)) {
  test(`decodes live ${name} transaction`, () => {
    const { events, truncated } = decodeTx(tx);
    assert.equal(truncated, false);
    const match = events.find((e) => e.kind === event.kind);
    assert.ok(match, `expected a ${String(event.kind)} event`);
    assert.deepEqual(match, event);
  });
}

test('live trade events have sane values', () => {
  for (const key of ['trade_buy', 'trade_sell']) {
    const ev = decodeTx(fixtures[key]!.tx).events.find((e) => e.kind === 'trade');
    assert.ok(ev && ev.kind === 'trade');
    assert.equal(ev.isBuy, key === 'trade_buy');
    assert.ok(ev.price > 0 && ev.price < 1, `price ${ev.price}`);
    assert.ok(ev.coinAmount > 0 && ev.quoteAmount > 0);
    assert.match(ev.mint, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  }
});

test('sell proceeds and creator fee match the on-chain balance change', () => {
  // The seller's SOL rose by 213,303,092 lamports after a 755,000 network fee and a 750,000 tip; the
  // 1,033,254 lamport buyback fee came out of the curve, not the seller.
  const ev = decodeTx(fixtures['trade_sell']!.tx).events.find((e) => e.kind === 'trade');
  assert.ok(ev && ev.kind === 'trade');
  assert.ok(Math.abs(ev.quoteAmount - 0.214808092) < 1e-12);
  assert.ok(Math.abs(ev.creatorFee! - 0.000652582) < 1e-12);
});

test('attributes Program data lines to the program executing at that depth', () => {
  const logs = [
    'Program Router111 invoke [1]',
    'Program PumpProg invoke [2]',
    'Program data: AAAA',
    'Program PumpProg invoke [3]',
    'Program PumpProg success',
    'Program PumpProg success',
    'Program data: BBBB',
    'Program Router111 success',
  ];
  const { items, truncated } = extractProgramData(logs);
  assert.equal(truncated, false);
  assert.deepEqual(items, [
    { program: 'PumpProg', entry: 'Router111', data: 'AAAA' },
    { program: 'Router111', entry: 'Router111', data: 'BBBB' },
  ]);
});

test('drops an identical event delivered under a second signature', () => {
  const { tx } = fixtures.trade_buy!;
  const dedupe = new PayloadDeduper();
  const stats = { undecodable: 0, duplicates: 0 };
  assert.equal(decodeTx(tx, stats, dedupe).events.length > 0, true);
  // The same transaction again (a reconnect re-delivery) keeps its events.
  assert.equal(decodeTx(tx, stats, dedupe).events.length > 0, true);
  // The same bytes under another signature are a copy.
  assert.equal(decodeTx({ ...tx, sig: 'other' }, stats, dedupe).events.length, 0);
  assert.ok(stats.duplicates > 0);
});

test('flags truncated logs', () => {
  assert.equal(extractProgramData(['Program X invoke [1]', 'Log truncated']).truncated, true);
});

test('ignores events from unrelated programs and undecodable data', () => {
  const tx: RawTx = {
    sig: 's',
    slot: 1,
    receivedAt: 0,
    logs: ['Program SomeOtherProgram invoke [1]', 'Program data: vdt/007mYe4=', 'Program SomeOtherProgram success'],
  };
  assert.deepEqual(decodeTx(tx).events, []);
});
