import { cpus } from 'node:os';
import { grindPool, vanityLeft } from '../live/vanity.ts';

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
if (args.includes('--help')) {
  console.log(`usage: npm run grind -- [--count 20] [--threads ${Math.max(1, cpus().length - 2)}]

Grinds mint addresses ending in "pump" into data/vanity/ for the launcher (about 2 minutes each on six threads).`);
  process.exit(0);
}
const count = Number(opt('count') ?? 20);
const threads = Number(opt('threads') ?? Math.max(1, cpus().length - 2));
console.log(`${vanityLeft()} in the pool; grinding ${count} more on ${threads} threads.`);
const start = Date.now();
await grindPool(count, threads, (a) => console.log(`${((Date.now() - start) / 1000).toFixed(0)} s  ${a}`));
console.log(`Done: ${vanityLeft()} in the pool.`);
