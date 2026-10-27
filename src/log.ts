import { config } from './config.ts';

const levels = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof levels;
const threshold = levels[(config.logLevel as Level) in levels ? (config.logLevel as Level) : 'info'];

function emit(level: Level, msg: string, extra?: Record<string, unknown>): void {
  if (levels[level] < threshold) return;
  const time = new Date().toISOString().slice(11, 23);
  const tail = extra ? ' ' + JSON.stringify(extra) : '';
  const line = `${time} ${level.toUpperCase().padEnd(5)} ${msg}${tail}`;
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
}

export const log = {
  debug: (msg: string, extra?: Record<string, unknown>) => emit('debug', msg, extra),
  info: (msg: string, extra?: Record<string, unknown>) => emit('info', msg, extra),
  warn: (msg: string, extra?: Record<string, unknown>) => emit('warn', msg, extra),
  error: (msg: string, extra?: Record<string, unknown>) => emit('error', msg, extra),
};
