import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Keypair } from '@solana/web3.js';
import { endsWithSuffix, grindOne, saveVanity, suffixValue, takeVanity, vanityLeft } from '../src/live/vanity.ts';

test('the suffix check agrees with base58 encoding', () => {
  for (let i = 0; i < 200; i++) {
    const kp = Keypair.generate();
    const tail = kp.publicKey.toBase58().slice(-2);
    assert.equal(endsWithSuffix(kp.publicKey.toBytes(), suffixValue(tail), 2), true);
  }
});

test('a ground key ends with the suffix, is a valid keypair, and the pool hands each out once', () => {
  const secret = grindOne('p')!;
  const kp = Keypair.fromSecretKey(secret);
  assert.ok(kp.publicKey.toBase58().endsWith('p'));
  const dir = mkdtempSync(join(tmpdir(), 'vanity-'));
  const address = saveVanity(secret, dir);
  assert.equal(address, kp.publicKey.toBase58());
  assert.equal(vanityLeft(dir, 'p'), 1);
  assert.deepEqual(takeVanity(dir, 'p'), secret);
  assert.equal(takeVanity(dir, 'p'), null);
  assert.equal(vanityLeft(dir, 'p'), 0);
});
