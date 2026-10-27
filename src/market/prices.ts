import { SOL, WSOL_MINT, quoteDecimals } from '../chain/programs.ts';
import { log } from '../log.ts';

const JUP_LITE_URL = 'https://lite-api.jup.ag/price/v3?ids=';
const JUP_PRO_URL = 'https://api.jup.ag/price/v3?ids=';
const COINBASE_SOL_URL = 'https://api.coinbase.com/v2/prices/SOL-USD/spot';

/**
 * USD prices for SOL and for every non-SOL quote asset seen on pump.fun (USDC, tokenized stocks, wrapped BTC,
 * pump coins used as quotes), so every trade can be valued in SOL. Polls Jupiter's free price API, and fetches a
 * newly seen quote asset within about a second.
 */
export class PriceBook {
  solUsd = 0;
  private readonly usd = new Map<string, number>();
  private readonly decimals = new Map<string, number>();
  private readonly wanted = new Set<string>();
  /** Quotes seen since the last fetch, fetched on their own so a new quote does not refetch everything. */
  private readonly fresh = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private soon: NodeJS.Timeout | null = null;
  private readonly jupiterApiKey: string | null;

  /** Without a Jupiter API key the free lite endpoint is used; it rate-limits at full pump.fun volume. */
  constructor(jupiterApiKey: string | null = null) {
    this.jupiterApiKey = jupiterApiKey;
  }

  async start(intervalMs = 30_000): Promise<void> {
    await this.refresh();
    this.timer = setInterval(() => void this.refresh(), intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.soon) clearTimeout(this.soon);
  }

  /**
   * SOL value of `amount` of `quote`, or null while that quote's price is unknown. `amount` is in whole units
   * as computed with `quoteDecimals(quote)`; it is rescaled when the mint's real decimals differ.
   */
  toSol(quote: string, amount: number): number | null {
    if (quote === SOL) return amount;
    const usd = this.usd.get(quote);
    if (usd === undefined) {
      this.want(quote);
      return null;
    }
    if (!(this.solUsd > 0)) return null;
    const actual = this.decimals.get(quote);
    const scale = actual === undefined ? 1 : 10 ** (quoteDecimals(quote) - actual);
    return (amount * scale * usd) / this.solUsd;
  }

  private want(quote: string): void {
    if (this.wanted.has(quote)) return;
    this.wanted.add(quote);
    this.fresh.add(quote);
    this.soon ??= setTimeout(() => {
      this.soon = null;
      const ids = [...this.fresh];
      this.fresh.clear();
      void this.fetchPrices(ids);
    }, 1_000);
  }

  private async refresh(): Promise<void> {
    await this.fetchPrices([WSOL_MINT, ...this.wanted]);
    if (!(this.solUsd > 0)) await this.refreshSolFallback();
  }

  private async fetchPrices(ids: string[]): Promise<void> {
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50);
      try {
        const res = await fetch((this.jupiterApiKey ? JUP_PRO_URL : JUP_LITE_URL) + chunk.join(','), {
          headers: this.jupiterApiKey ? { 'x-api-key': this.jupiterApiKey } : {},
          signal: AbortSignal.timeout(8_000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as Record<string, { usdPrice?: number; decimals?: number } | null>;
        for (const id of chunk) {
          const entry = body[id];
          const p = entry?.usdPrice;
          if (typeof p !== 'number' || !(p > 0)) continue;
          if (id === WSOL_MINT) this.solUsd = p;
          else {
            this.usd.set(id, p);
            if (typeof entry?.decimals === 'number') this.decimals.set(id, entry.decimals);
          }
        }
      } catch (err) {
        log.warn('Jupiter price refresh failed', { error: String(err) });
      }
    }
  }

  private async refreshSolFallback(): Promise<void> {
    try {
      const res = await fetch(COINBASE_SOL_URL, { signal: AbortSignal.timeout(8_000) });
      const body = (await res.json()) as { data?: { amount?: string } };
      const p = Number(body.data?.amount);
      if (p > 0) this.solUsd = p;
    } catch (err) {
      log.warn('Coinbase SOL price failed', { error: String(err) });
    }
  }
}
