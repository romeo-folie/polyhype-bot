/**
 * High-performance pretty logger for live monitoring.
 * Outputs colored, readable text instead of raw JSON for dashboard visibility.
 */

type Level = 'debug' | 'info' | 'warn' | 'error';

const COLORS: Record<Level, string> = {
  debug: '\x1b[38;5;244m', // Visible Gray
  info: '\x1b[36m',       // Cyan
  warn: '\x1b[33m',       // Yellow
  error: '\x1b[31m',      // Red
};
const RESET = '\x1b[0m';
const DIM = '\x1b[2m';

function log(level: Level, msg: string, extra?: Record<string, unknown>): void {
  const ts = new Date().toLocaleTimeString('en-GB', { hour12: false });
  const color = COLORS[level];
  
  // Format the main message line
  let output = `${DIM}${ts}${RESET} ${color}${level.toUpperCase().padEnd(5)}${RESET} ${msg}`;
  
  // Flatten and colorize extra data if present
  if (extra && Object.keys(extra).length > 0) {
    const extraStr = Object.entries(extra)
      .map(([k, v]) => `${DIM}${k}=${RESET}${v}`)
      .join(' ');
    output += ` ${DIM}|${RESET} ${extraStr}`;
  }

  if (level === 'error') {
    process.stderr.write(output + '\n');
  } else {
    process.stdout.write(output + '\n');
  }
}

export const logger = {
  debug: (msg: string, extra?: Record<string, unknown>) => log('debug', msg, extra),
  info: (msg: string, extra?: Record<string, unknown>) => log('info', msg, extra),
  warn: (msg: string, extra?: Record<string, unknown>) => log('warn', msg, extra),
  error: (msg: string, extra?: Record<string, unknown>) => log('error', msg, extra),
};
