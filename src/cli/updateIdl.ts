import { writeFileSync } from 'node:fs';

/**
 * Refreshes the pump.fun program IDLs from pump.fun's public docs repository. Run this when pump.fun announces a
 * program upgrade; new event fields are appended, so an older IDL keeps decoding until then.
 */
const BASE = 'https://raw.githubusercontent.com/pump-fun/pump-public-docs/main/idl/';

for (const name of ['pump', 'pump_amm', 'pump_fees']) {
  const res = await fetch(`${BASE}${name}.json`, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`${name}.json: HTTP ${res.status}`);
  const idl = (await res.json()) as { address?: string };
  if (!idl.address) throw new Error(`${name}.json does not look like an Anchor IDL`);
  writeFileSync(new URL(`../../idl/${name}.json`, import.meta.url), JSON.stringify(idl, null, 2) + '\n');
  console.log(`updated idl/${name}.json (${idl.address})`);
}
