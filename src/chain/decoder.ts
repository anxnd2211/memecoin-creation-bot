import { readFileSync } from 'node:fs';
import { BorshCoder, type Idl } from '@coral-xyz/anchor';
import type { DecodedEvent, RawTx } from './events.ts';
import { COIN_DECIMALS, PUMP_AMM_PROGRAM, PUMP_PROGRAM, normalizeQuote, quoteDecimals } from './programs.ts';

function loadIdl(name: string): Idl {
  return JSON.parse(readFileSync(new URL(`../../idl/${name}.json`, import.meta.url), 'utf8')) as Idl;
}

const coders: Record<string, BorshCoder> = {
  [PUMP_PROGRAM]: new BorshCoder(loadIdl('pump')),
  [PUMP_AMM_PROGRAM]: new BorshCoder(loadIdl('pump_amm')),
};

export const ammAccountCoder = coders[PUMP_AMM_PROGRAM]!.accounts;

/** A `Program data:` line attributed to the program that was executing when it was logged. */
export interface ProgramData {
  program: string;
  data: string;
}

const INVOKE = /^Program (\w+) invoke \[\d+\]$/;
const EXIT = /^Program (\w+) (?:success|failed)/;

/** Walks the invoke stack in a transaction's logs so each emitted event is attributed to the right program. */
export function extractProgramData(logs: string[]): { items: ProgramData[]; truncated: boolean } {
  const stack: string[] = [];
  const items: ProgramData[] = [];
  let truncated = false;
  for (const line of logs) {
    if (line.startsWith('Program data: ')) {
      const program = stack[stack.length - 1];
      if (program) items.push({ program, data: line.slice(14) });
      continue;
    }
    if (line === 'Log truncated') {
      truncated = true;
      continue;
    }
    const inv = INVOKE.exec(line);
    if (inv) {
      stack.push(inv[1]!);
      continue;
    }
    if (EXIT.test(line)) stack.pop();
  }
  return { items, truncated };
}

type Fields = Record<string, unknown>;

function n(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  if (v && typeof (v as { toString(): string }).toString === 'function') return Number(String(v));
  return 0;
}

function key(v: unknown): string {
  return (v as { toBase58(): string }).toBase58();
}

function decodePump(name: string, d: Fields, sig: string, slot: number): DecodedEvent | null {
  switch (name) {
    case 'CreateEvent': {
      const quote = normalizeQuote(key(d.quote_mint));
      const vQuote = n(d.virtual_quote_reserves) || n(d.virtual_sol_reserves);
      const vCoin = n(d.virtual_token_reserves);
      return {
        kind: 'launch',
        sig,
        slot,
        ts: n(d.timestamp),
        mint: key(d.mint),
        name: String(d.name),
        symbol: String(d.symbol),
        uri: String(d.uri),
        creator: key(d.creator),
        user: key(d.user),
        quote,
        totalSupply: n(d.token_total_supply) / 10 ** COIN_DECIMALS,
        price: vCoin > 0 ? vQuote / 10 ** quoteDecimals(quote) / (vCoin / 10 ** COIN_DECIMALS) : 0,
        isMayhem: Boolean(d.is_mayhem_mode),
        isHolderReward: Boolean(d.is_holder_reward),
      };
    }
    case 'TradeEvent': {
      const quote = normalizeQuote(key(d.quote_mint));
      const qd = 10 ** quoteDecimals(quote);
      const isBuy = Boolean(d.is_buy);
      const gross = n(d.quote_amount) || n(d.sol_amount);
      // Protocol and creator fees are charged on top of a buy and taken out of a sell.
      const fees = n(d.fee) + n(d.creator_fee);
      const coinRaw = n(d.token_amount);
      const vQuote = n(d.virtual_quote_reserves) || n(d.virtual_sol_reserves);
      const vCoin = n(d.virtual_token_reserves);
      const price =
        vCoin > 0
          ? vQuote / qd / (vCoin / 10 ** COIN_DECIMALS)
          : coinRaw > 0
            ? gross / qd / (coinRaw / 10 ** COIN_DECIMALS)
            : 0;
      return {
        kind: 'trade',
        sig,
        slot,
        ts: n(d.timestamp),
        venue: 'curve',
        mint: key(d.mint),
        wallet: key(d.user),
        isBuy,
        quote,
        quoteAmount: (isBuy ? gross + fees : Math.max(0, gross - fees)) / qd,
        coinAmount: coinRaw / 10 ** COIN_DECIMALS,
        price,
      };
    }
    case 'CompleteEvent':
      return { kind: 'graduate', sig, slot, ts: n(d.timestamp), mint: key(d.mint) };
    case 'CompletePumpAmmMigrationEvent':
      return {
        kind: 'migrate',
        sig,
        slot,
        ts: n(d.timestamp),
        mint: key(d.mint),
        pool: key(d.pool),
        quote: normalizeQuote(key(d.quote_mint)),
      };
    default:
      return null;
  }
}

function decodeAmm(name: string, d: Fields, sig: string, slot: number): DecodedEvent | null {
  switch (name) {
    case 'CreatePoolEvent':
      return {
        kind: 'pool',
        sig,
        slot,
        ts: n(d.timestamp),
        pool: key(d.pool),
        baseMint: key(d.base_mint),
        quoteMint: key(d.quote_mint),
        creator: key(d.coin_creator),
      };
    case 'BuyEvent':
      return {
        kind: 'pool_trade',
        sig,
        slot,
        ts: n(d.timestamp),
        pool: key(d.pool),
        wallet: key(d.user),
        baseBuy: true,
        baseAmountRaw: n(d.base_amount_out),
        quoteAmountRaw: n(d.user_quote_amount_in),
        quoteAmountNoFeeRaw: n(d.quote_amount_in),
      };
    case 'SellEvent':
      return {
        kind: 'pool_trade',
        sig,
        slot,
        ts: n(d.timestamp),
        pool: key(d.pool),
        wallet: key(d.user),
        baseBuy: false,
        baseAmountRaw: n(d.base_amount_in),
        quoteAmountRaw: n(d.user_quote_amount_out),
        quoteAmountNoFeeRaw: n(d.quote_amount_out),
      };
    default:
      return null;
  }
}

export interface DecodeStats {
  undecodable: number;
  duplicates: number;
}

/**
 * Remembers recent event payloads by signature. The same bytes under a different signature is a re-delivered or
 * phantom copy (seen on the public RPC: identical trades from two signatures, neither of which landed). Distinct
 * real events never share bytes across transactions because cumulative fee fields change on every trade.
 */
export class PayloadDeduper {
  private readonly seen = new Map<string, string>();
  private readonly max: number;

  constructor(max = 200_000) {
    this.max = max;
  }

  isDuplicate(data: string, sig: string): boolean {
    const prev = this.seen.get(data);
    if (prev !== undefined) return prev !== sig;
    this.seen.set(data, sig);
    if (this.seen.size > this.max) this.seen.delete(this.seen.keys().next().value!);
    return false;
  }
}

/** Decodes every pump.fun and PumpSwap event in a transaction's logs. */
export function decodeTx(
  tx: RawTx,
  stats?: DecodeStats,
  dedupe?: PayloadDeduper,
): { events: DecodedEvent[]; truncated: boolean } {
  const { items, truncated } = extractProgramData(tx.logs);
  const events: DecodedEvent[] = [];
  for (const item of items) {
    const coder = coders[item.program];
    if (!coder) continue;
    if (dedupe?.isDuplicate(item.data, tx.sig)) {
      if (stats) stats.duplicates++;
      continue;
    }
    let ev: { name: string; data: Fields } | null = null;
    try {
      ev = coder.events.decode(item.data) as { name: string; data: Fields } | null;
    } catch {
      if (stats) stats.undecodable++;
      continue;
    }
    if (!ev) continue;
    const out =
      item.program === PUMP_PROGRAM
        ? decodePump(ev.name, ev.data, tx.sig, tx.slot)
        : decodeAmm(ev.name, ev.data, tx.sig, tx.slot);
    if (out) events.push(out);
  }
  return { events, truncated };
}
