/**
 * Minimal structured logger.
 * Outputs JSON lines to stdout for easy parsing by log aggregators.
 */

type Level = 'debug' | 'info' | 'warn' | 'error';

interface LogRecord {
  ts: string;
  level: Level;
  msg: string;
  [key: string]: unknown;
}

const levels: Record<Level, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function getLogLevel(): number {
  const level = (process.env['LOG_LEVEL'] || 'info').toLowerCase() as Level;
  return levels[level] ?? 1;
}

function log(level: Level, msg: string, extra?: Record<string, unknown>): void {
  const currentLevel = getLogLevel();
  if (levels[level] < currentLevel) return;

  const record: LogRecord = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...extra,
  };
  const line = JSON.stringify(record);
  if (level === 'error') {
    console.error(line);
  } else {
    console.log(line);
  }
}

export const logger = {
  debug: (msg: string, extra?: Record<string, unknown>) => log('debug', msg, extra),
  info: (msg: string, extra?: Record<string, unknown>) => log('info', msg, extra),
  warn: (msg: string, extra?: Record<string, unknown>) => log('warn', msg, extra),
  error: (msg: string, extra?: Record<string, unknown>) => log('error', msg, extra),
};
