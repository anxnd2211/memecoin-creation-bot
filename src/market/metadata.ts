import type { CoinMeta } from '../intel/state.ts';

const MAX_QUEUE = 5_000;

function str(v: unknown, max = 500): string | null {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
}

/** Candidate URLs for a metadata URI: the URI itself, then the same IPFS content through each gateway. */
export function candidateUrls(uri: string, gateways: string[]): string[] {
  const urls: string[] = [];
  let cid: string | null = null;
  if (uri.startsWith('ipfs://')) cid = uri.slice(7);
  else {
    const i = uri.indexOf('/ipfs/');
    if (i >= 0) cid = uri.slice(i + 6);
    if (uri.startsWith('http')) urls.push(uri);
  }
  if (cid) for (const g of gateways) urls.push(g + cid);
  return [...new Set(urls)];
}

export function parseMeta(body: Record<string, unknown>): CoinMeta {
  return {
    description: str(body.description, 1_000),
    image: str(body.image),
    twitter: str(body.twitter),
    telegram: str(body.telegram),
    website: str(body.website),
  };
}

/** Fetches coin metadata JSON (description, image, socials) with bounded concurrency. */
export class MetadataFetcher {
  readonly stats = { ok: 0, failed: 0, dropped: 0 };
  private readonly queue: { mint: string; uri: string }[] = [];
  private active = 0;
  private readonly gateways: string[];
  private readonly onResult: (mint: string, status: 'done' | 'failed', meta: CoinMeta | null) => void;
  private readonly concurrency: number;

  constructor(
    gateways: string[],
    onResult: (mint: string, status: 'done' | 'failed', meta: CoinMeta | null) => void,
    concurrency = 6,
  ) {
    this.gateways = gateways;
    this.onResult = onResult;
    this.concurrency = concurrency;
  }

  get queued(): number {
    return this.queue.length;
  }

  enqueue(mint: string, uri: string): void {
    if (this.queue.length >= MAX_QUEUE) {
      this.stats.dropped++;
      return;
    }
    this.queue.push({ mint, uri });
    this.pump();
  }

  private pump(): void {
    while (this.active < this.concurrency && this.queue.length) {
      const job = this.queue.shift()!;
      this.active++;
      void this.fetchOne(job.uri)
        .then((meta) => {
          this.stats.ok++;
          this.onResult(job.mint, 'done', meta);
        })
        .catch(() => {
          this.stats.failed++;
          this.onResult(job.mint, 'failed', null);
        })
        .finally(() => {
          this.active--;
          this.pump();
        });
    }
  }

  private async fetchOne(uri: string): Promise<CoinMeta> {
    let lastErr: unknown = new Error('no usable URL');
    for (const url of candidateUrls(uri, this.gateways)) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return parseMeta((await res.json()) as Record<string, unknown>);
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr;
  }
}
