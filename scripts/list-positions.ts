import { getRedis } from '../src/shared/redis.js';
import { getOpenPositions, formatDirection, type Position } from '../src/execution/positionLedger.js';
import { fetchAllCurrentPrices, type CurrentPrice } from '../src/monitor/priceFetcher.js';
import { logger } from '../src/shared/logger.js';

async function run() {
  const redis = getRedis();
  
  try {
    const positions = await getOpenPositions(redis);
    
    if (positions.length === 0) {
      console.log('\x1b[33mNo active positions found.\x1b[0m');
      process.exit(0);
    }

    // Fetch live prices for all positions to show real-time P&L
    const prices: Map<string, CurrentPrice> = await fetchAllCurrentPrices(positions);

    console.clear();
    console.log(`\x1b[1mActive Positions (${positions.length})\x1b[0m`);
    console.log('='.repeat(80));
    
    const tableData = positions.map((p: Position) => {
      const live = prices.get(`${p.marketId}:${p.direction}`);
      const currentPrice = live ? live.currentOutcomePrice : p.entryPrice;
      const pnlPct = p.entryPrice > 0 ? ((currentPrice - p.entryPrice) / p.entryPrice) * 100 : 0;
      
      const pnlColor = pnlPct >= 0 ? '\x1b[32m' : '\x1b[31m';
      const reset = '\x1b[0m';

      return {
        Market: p.question.length > 40 ? p.question.slice(0, 37) + '...' : p.question,
        Side: formatDirection(p.direction),
        Entry: p.entryPrice.toFixed(3),
        Live: currentPrice.toFixed(3),
        PnL: `${pnlColor}${pnlPct.toFixed(1)}%${reset}`,
        Stake: `$${p.stakeUsd.toFixed(0)}`,
        Source: p.sourcedFrom.split(':')[0] // e.g. "copytrade" or "headline"
      };
    });

    // Manually format table for terminal width and colors
    console.log('%-40s %-10s %-8s %-8s %-10s %-8s %-10s', 'MARKET', 'SIDE', 'ENTRY', 'LIVE', 'PNL', 'STAKE', 'SOURCE');
    console.log('-'.repeat(80));
    
    for (const row of tableData) {
      console.log(
        '%-40s %-20s %-8s %-8s %-18s %-8s %-10s', 
        row.Market, 
        row.Side, 
        row.Entry, 
        row.Live, 
        row.PnL, 
        row.Stake, 
        row.Source
      );
    }
    
    console.log('='.repeat(80));
    console.log(`Last updated: ${new Date().toLocaleTimeString()}`);

  } catch (err) {
    console.error('Error fetching positions:', err);
  } finally {
    process.exit(0);
  }
}

run();
