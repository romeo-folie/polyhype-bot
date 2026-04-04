import { getRedis } from '../src/shared/redis.js';
import { getOpenPositions, formatDirection } from '../src/execution/positionLedger.js';
import { fetchAllCurrentPrices, type CurrentPrice } from '../src/monitor/priceFetcher.js';

async function run() {
  const redis = getRedis();
  
  try {
    const positions = await getOpenPositions(redis);
    
    // Move cursor to top-left (H) and clear from cursor down (J) only after we have data
    // This prevents the "blinking" caused by clearing the screen while the script is still loading.
    process.stdout.write('\x1b[H');

    if (positions.length === 0) {
      console.log('\x1b[33mNo active positions found.\x1b[0m');
      process.stdout.write('\x1b[J'); // Clear the rest of the old table
      process.exit(0);
    }

    const prices: Map<string, CurrentPrice> = await fetchAllCurrentPrices(positions);

    console.log(`\x1b[1mActive Positions (${positions.length})\x1b[0m`);
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
      const currentPrice = live ? live.currentOutcomePrice : p.entryPrice;
      const pnlPct = p.entryPrice > 0 ? ((currentPrice - p.entryPrice) / p.entryPrice) * 100 : 0;
      
      const pnlColor = pnlPct >= 0 ? '\x1b[32m' : '\x1b[31m';
      const reset = '\x1b[0m';

      const market = (p.question.length > 42 ? p.question.slice(0, 39) + '...' : p.question).padEnd(45);
      const side = formatDirection(p.direction).padEnd(10);
      const entry = p.entryPrice.toFixed(3).padEnd(10);
      const livePrice = currentPrice.toFixed(3).padEnd(10);
      const pnl = `${pnlColor}${pnlPct.toFixed(1)}%${reset}`.padEnd(10 + pnlColor.length + reset.length);
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
