import { getRedis } from '../src/shared/redis.js';
import { getOpenPositions, formatDirection } from '../src/execution/positionLedger.js';
import { fetchAllCurrentPrices, type CurrentPrice } from '../src/monitor/priceFetcher.js';

async function run() {
  const redis = getRedis();
  
  try {
    const positions = await getOpenPositions(redis);
    
    const prices: Map<string, CurrentPrice> = await fetchAllCurrentPrices(positions);
    
    // Clear the screen and reset cursor to top.
    // console.clear() works better with tmux's scrollback buffer than manual \x1b[H resets.
    console.clear();

    console.log(`\x1b[1mActive Positions (${positions.length})\x1b[0m   [Scroll: Mouse Wheel or Ctrl+B, []`);
    console.log('='.repeat(100));
    
    // Header
    const header = [
      'MARKET'.padEnd(45),
      'SIDE'.padEnd(10),
      'ENTRY'.padEnd(10),
      'LIVE'.padEnd(10),
      'PNL'.padEnd(10),
      'STAKE'.padEnd(10),
      'SOURCE'.padEnd(10)
    ].join(' ');
    
    console.log(header);
    console.log('-'.repeat(100));

    for (const p of positions) {
      const live = prices.get(`${p.marketId}:${p.direction}`);
      const currentPrice = live ? live.currentOutcomePrice : null;
      const hasReliableEntry = p.entryPrice > 0;
      const pnlPct = hasReliableEntry && currentPrice !== null
        ? ((currentPrice - p.entryPrice) / p.entryPrice) * 100
        : null;

      const reset = '\x1b[0m';
      const dim = '\x1b[2m';

      const market = (p.question.length > 42 ? p.question.slice(0, 39) + '...' : p.question).padEnd(45);
      const side = formatDirection(p.direction).padEnd(10);
      const entry = hasReliableEntry ? p.entryPrice.toFixed(3).padEnd(10) : `${dim}N/A${reset}`.padEnd(10 + dim.length + reset.length);
      const livePrice = currentPrice !== null ? currentPrice.toFixed(3).padEnd(10) : `${dim}---${reset}`.padEnd(10 + dim.length + reset.length);
      const pnl = pnlPct !== null
        ? `${pnlPct >= 0 ? '\x1b[32m' : '\x1b[31m'}${pnlPct.toFixed(1)}%${reset}`.padEnd(10 + 5 + reset.length)
        : `${dim}N/A${reset}`.padEnd(10 + dim.length + reset.length);
      const stake = `$${p.stakeUsd.toFixed(0)}`.padEnd(10);
      const source = p.sourcedFrom.split(':')[0]!.padEnd(10);

      console.log(`${market} ${side} ${entry} ${livePrice} ${pnl} ${stake} ${source}`);
    }
    
    console.log('='.repeat(100));
    console.log(`Last updated: ${new Date().toLocaleTimeString()}`);
    
    // Clear any leftover lines from the previous (longer) table run
    process.stdout.write('\x1b[J');

  } catch (err) {
    // Silently fail during dashboard polling
  } finally {
    process.exit(0);
  }
}

run().catch((err: unknown) => console.error(err));
