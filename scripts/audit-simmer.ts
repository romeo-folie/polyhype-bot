/**
 * Simmer wallet audit — pulls all data and cross-checks balances.
 *
 * Usage: npx tsx scripts/audit-simmer.ts
 */
import 'dotenv/config';

const BASE = 'https://api.simmer.markets';
const KEY = process.env.SIMMER_API_KEY;
if (!KEY) {
  console.error('SIMMER_API_KEY not set');
  process.exit(1);
}

const headers = { Authorization: `Bearer ${KEY}` };

async function get(path: string, params?: Record<string, string>) {
  const url = new URL(path, BASE);
  if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const resp = await fetch(url.toString(), { headers });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    console.error(`GET ${path} → HTTP ${resp.status}: ${body}`);
    return null;
  }
  return resp.json();
}

async function main() {
  console.log('=== SIMMER WALLET AUDIT ===\n');

  // 1. Agent info (balance + P&L)
  const agent = await get('/api/sdk/agents/me', { include: 'pnl' });
  console.log('── Agent Info ──');
  console.log(JSON.stringify(agent, null, 2));

  // 2. Portfolio
  const portfolio = await get('/api/sdk/portfolio');
  console.log('\n── Portfolio ──');
  console.log(JSON.stringify(portfolio, null, 2));

  // 3. Briefing (venue breakdown)
  const briefing = await get('/api/sdk/briefing');
  console.log('\n── Briefing ──');
  console.log(JSON.stringify(briefing, null, 2));

  // 4. All trades
  const trades = await get('/api/sdk/trades', { venue: 'polymarket' });
  console.log('\n── All Trades (polymarket venue) ──');
  const tradeArr = Array.isArray(trades)
    ? trades
    : Array.isArray((trades as Record<string, unknown>)?.trades)
      ? ((trades as Record<string, unknown>).trades as unknown[])
      : null;

  if (tradeArr) {
    console.log(`Total trades: ${tradeArr.length}`);
    let totalSpent = 0;
    let totalSells = 0;
    let totalRedeems = 0;
    let buyCount = 0, sellCount = 0, redeemCount = 0;
    for (const t of tradeArr) {
      const rec = t as Record<string, unknown>;
      const cost = Number(rec.cost ?? rec.amount ?? 0);
      const action = String(rec.action ?? 'buy').toLowerCase();
      if (action === 'redeem') { totalRedeems += cost; redeemCount++; }
      else if (action === 'sell') { totalSells += cost; sellCount++; }
      else { totalSpent += cost; buyCount++; }
      console.log(
        `  ${rec.created_at ?? rec.timestamp ?? '?'} | ${action.toUpperCase().padEnd(6)} | $${cost.toFixed(2).padStart(6)} | side=${rec.side ?? '?'} | shares=${rec.shares_bought ?? rec.shares_sold ?? '?'} | price=${rec.price ?? '?'} | market=${String(rec.question ?? rec.market_id ?? '').slice(0, 60)}`,
      );
    }
    console.log(`\n  Buys:    ${buyCount} trades, $${totalSpent.toFixed(2)} spent`);
    console.log(`  Sells:   ${sellCount} trades, $${totalSells.toFixed(2)} received`);
    console.log(`  Redeems: ${redeemCount} trades, $${totalRedeems.toFixed(2)} received`);
    console.log(`  Net cash flow: $${(totalRedeems + totalSells - totalSpent).toFixed(2)}`);
  } else {
    console.log(JSON.stringify(trades, null, 2));
  }

  // 5. Positions by status
  for (const status of ['active', 'resolved', 'closed'] as const) {
    const positions = await get('/api/sdk/positions', { status, venue: 'polymarket' });
    console.log(`\n── Positions (${status}) ──`);
    const arr = Array.isArray(positions)
      ? positions
      : Array.isArray((positions as Record<string, unknown>)?.positions)
        ? ((positions as Record<string, unknown>).positions as unknown[])
        : [];
    console.log(`Count: ${arr.length}`);
    let totalValue = 0;
    for (const p of arr) {
      const rec = p as Record<string, unknown>;
      const val = Number(rec.value_usdc ?? rec.current_value ?? 0);
      const pnl = Number(rec.pnl ?? rec.realized_pnl ?? 0);
      totalValue += val;
      console.log(
        `  ${rec.redeemable ? '✓ REDEEMABLE' : '  '} | side=${rec.side ?? '?'} | shares=${rec.shares ?? '?'} | value=$${val.toFixed(2)} | pnl=$${pnl.toFixed(2)} | outcome=${rec.outcome ?? '?'} | redeemable_side=${rec.redeemable_side ?? 'null'} | market=${String(rec.question ?? rec.market_id ?? '').slice(0, 60)}`,
      );
    }
    console.log(`  Total value: $${totalValue.toFixed(2)}`);
  }

  // 6. Settings
  const settings = await get('/api/sdk/settings');
  console.log('\n── Settings ──');
  console.log(JSON.stringify(settings, null, 2));

  // 7. Summary reconciliation
  console.log('\n=== RECONCILIATION SUMMARY ===');
  const bal = portfolio?.balance_usdc ?? agent?.balance ?? '?';
  const pnl = portfolio?.pnl_total ?? agent?.pnl ?? agent?.pnl_total ?? '?';
  const exposure = portfolio?.total_exposure ?? '?';
  console.log(`  Simmer USDC balance:  $${bal}`);
  console.log(`  Total P&L (Simmer):   $${pnl}`);
  console.log(`  Total exposure:       $${exposure}`);
  console.log(`  Positions count:      ${portfolio?.positions_count ?? '?'}`);
  console.log(`  Redeemable count:     ${portfolio?.redeemable_count ?? '?'}`);
}

main().catch((err) => {
  console.error('Audit failed:', err);
  process.exit(1);
});
