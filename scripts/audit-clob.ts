/**
 * CLOB wallet audit — checks on-chain balances, Redis ledger positions,
 * and cross-references with Gamma for unredeemed winning tokens.
 *
 * Usage: npx tsx scripts/audit-clob.ts
 */
import 'dotenv/config';
import { Wallet, Contract, JsonRpcProvider, Network, FetchRequest } from 'ethers';
import Redis from 'ioredis';

const CTF_ADDRESS = '0x4d97dcd97ec945f40cf65f87097ace5ea0476045';
const USDC_E_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const POLYGON_RPCS = [
  process.env.POLYGON_RPC_URL,
  'https://polygon-rpc.com',
  'https://polygon.llamarpc.com',
  'https://polygon-bor-rpc.publicnode.com',
].filter(Boolean) as string[];

const PRIVATE_KEY = process.env.POLYGON_WALLET_PRIVATE_KEY;
const SIG_TYPE = parseInt(process.env.POLYMARKET_SIGNATURE_TYPE ?? '0', 10);
const FUNDER_ADDRESS = process.env.POLYMARKET_FUNDER_ADDRESS;

function getWalletAddress(): string {
  if (SIG_TYPE === 1 && FUNDER_ADDRESS) return FUNDER_ADDRESS;
  if (!PRIVATE_KEY) throw new Error('POLYGON_WALLET_PRIVATE_KEY not set');
  return new Wallet(PRIVATE_KEY).address;
}

async function getProvider(): Promise<JsonRpcProvider> {
  for (const rpcUrl of POLYGON_RPCS) {
    try {
      const net = new Network('matic', 137);
      const fetchReq = new FetchRequest(rpcUrl);
      fetchReq.timeout = 10_000;
      const provider = new JsonRpcProvider(fetchReq, net, { staticNetwork: net });
      await provider.getBlockNumber(); // test connectivity
      console.log(`Using RPC: ${rpcUrl}`);
      return provider;
    } catch {
      console.log(`RPC failed: ${rpcUrl}`);
    }
  }
  throw new Error('All RPCs failed');
}

async function main() {
  console.log('=== CLOB WALLET AUDIT ===\n');

  if (!PRIVATE_KEY) {
    console.log('POLYGON_WALLET_PRIVATE_KEY not configured — CLOB is not active. Exiting.');
    return;
  }

  const walletAddress = getWalletAddress();
  console.log(`Wallet address: ${walletAddress}`);
  console.log(`Signature type: ${SIG_TYPE} (${SIG_TYPE === 0 ? 'EOA' : SIG_TYPE === 1 ? 'Proxy' : 'Gnosis'})`);

  const provider = await getProvider();

  // 1. On-chain USDC.e balance
  const usdcAbi = ['function balanceOf(address) view returns (uint256)'];
  const usdc = new Contract(USDC_E_ADDRESS, usdcAbi, provider);
  const rawUsdc: bigint = await (usdc as any).balanceOf(walletAddress);
  const usdcBalance = Number(rawUsdc) / 1_000_000;
  console.log(`\n── On-chain USDC.e balance: $${usdcBalance.toFixed(6)} ──`);

  // 2. On-chain MATIC balance (for gas)
  const maticRaw = await provider.getBalance(walletAddress);
  const maticBalance = Number(maticRaw) / 1e18;
  console.log(`── MATIC balance (gas): ${maticBalance.toFixed(6)} MATIC ──`);

  // 3. Redis ledger positions (CLOB venue)
  console.log('\n── Redis Ledger (CLOB positions) ──');
  const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
  const redis = new Redis(redisUrl);

  const positionKeys = await redis.keys('position:*');
  const clobPositions: Array<{
    marketId: string;
    direction: string;
    conditionId?: string;
    clobTokenIds?: string[];
    venue: string;
    stakeUsd: number;
    sharesHeld?: number;
    entryPrice: number;
    question?: string;
  }> = [];
  const allPositions: typeof clobPositions = [];

  for (const key of positionKeys) {
    const data = await redis.hgetall(key);
    if (!data.marketId) continue;
    const pos = {
      marketId: data.marketId,
      direction: data.direction ?? '?',
      conditionId: data.conditionId,
      clobTokenIds: data.clobTokenIds ? JSON.parse(data.clobTokenIds) : undefined,
      venue: data.executionVenue ?? 'unknown',
      stakeUsd: parseFloat(data.stakeUsd ?? '0'),
      sharesHeld: data.sharesHeld ? parseFloat(data.sharesHeld) : undefined,
      entryPrice: parseFloat(data.entryPrice ?? '0'),
      question: data.question,
    };
    allPositions.push(pos);
    if (pos.venue === 'clob') clobPositions.push(pos);
  }

  console.log(`Total ledger positions: ${allPositions.length}`);
  console.log(`CLOB-venue positions: ${clobPositions.length}`);
  console.log(`Simmer-venue positions: ${allPositions.filter(p => p.venue === 'simmer' || p.venue === 'unknown').length}`);

  if (clobPositions.length > 0) {
    for (const pos of clobPositions) {
      console.log(`\n  Market: ${(pos.question ?? pos.marketId).slice(0, 70)}`);
      console.log(`    direction=${pos.direction} stake=$${pos.stakeUsd.toFixed(2)} entry=${pos.entryPrice} shares=${pos.sharesHeld ?? '?'}`);
      console.log(`    conditionId=${pos.conditionId ?? 'missing'}`);
      console.log(`    tokenIds=${pos.clobTokenIds?.map(t => t.slice(0, 20) + '...').join(', ') ?? 'missing'}`);
    }
  }

  // 4. Check on-chain token balances for ALL ledger positions (not just CLOB)
  console.log('\n── On-chain Token Balances ──');
  const ctfBalanceAbi = ['function balanceOf(address, uint256) view returns (uint256)'];
  const ctf = new Contract(CTF_ADDRESS, ctfBalanceAbi, provider);

  const tokenBalances: Array<{
    tokenId: string;
    balance: number;
    marketId: string;
    question?: string;
    side: string;
  }> = [];

  // Collect all unique token IDs from ALL positions
  const checkedTokens = new Set<string>();
  for (const pos of allPositions) {
    if (!pos.clobTokenIds) continue;
    for (let i = 0; i < pos.clobTokenIds.length; i++) {
      const tokenId = pos.clobTokenIds[i];
      if (checkedTokens.has(tokenId)) continue;
      checkedTokens.add(tokenId);

      try {
        const rawBal: bigint = await (ctf as any).balanceOf(walletAddress, tokenId);
        const balance = Number(rawBal) / 1_000_000;
        const side = i === 0 ? 'YES' : 'NO';
        tokenBalances.push({ tokenId, balance, marketId: pos.marketId, question: pos.question, side });
        if (balance > 0) {
          console.log(`  ✓ ${balance.toFixed(4)} shares | ${side} | ${(pos.question ?? pos.marketId).slice(0, 60)}`);
        }
      } catch (err) {
        console.log(`  ✗ Failed to check token ${tokenId.slice(0, 20)}... — ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  const nonZeroBalances = tokenBalances.filter(t => t.balance > 0.001);
  console.log(`\nTokens with balance > 0: ${nonZeroBalances.length}`);

  // 5. Cross-reference non-zero balances with Gamma for resolution status
  if (nonZeroBalances.length > 0) {
    console.log('\n── Checking resolution status (Gamma API) ──');

    const ctfPayoutAbi = [
      'function payoutDenominator(bytes32) view returns (uint256)',
      'function payoutNumerators(bytes32, uint256) view returns (uint256)',
    ];
    const ctfPayout = new Contract(CTF_ADDRESS, ctfPayoutAbi, provider);

    // Group by conditionId
    const conditionIds = new Set<string>();
    for (const tb of nonZeroBalances) {
      const pos = allPositions.find(p => p.clobTokenIds?.includes(tb.tokenId));
      if (pos?.conditionId) conditionIds.add(pos.conditionId);
    }

    for (const conditionId of conditionIds) {
      try {
        // Check Gamma
        const gammaResp = await fetch(
          `https://gamma-api.polymarket.com/markets?condition_id=${encodeURIComponent(conditionId)}`,
          { signal: AbortSignal.timeout(10_000) },
        );
        const gammaData = await gammaResp.json() as any[];
        const market = gammaData[0];

        if (!market) {
          console.log(`  [${conditionId.slice(0, 12)}...] Not found on Gamma`);
          continue;
        }

        const question = market.question ?? market.title ?? conditionId;
        const resolved = market.resolved || market.closed;

        let outcome: string | null = null;
        if (market.outcomePrices) {
          try {
            const prices = JSON.parse(market.outcomePrices);
            if (parseFloat(prices[0]) === 1) outcome = 'YES';
            else if (parseFloat(prices[1]) === 1) outcome = 'NO';
          } catch {}
        }

        // Also check on-chain payout
        if (!outcome) {
          try {
            const denom: bigint = await (ctfPayout as any).payoutDenominator(conditionId);
            if (denom > 0n) {
              const yesNum: bigint = await (ctfPayout as any).payoutNumerators(conditionId, 0);
              const noNum: bigint = await (ctfPayout as any).payoutNumerators(conditionId, 1);
              if (yesNum > 0n && noNum === 0n) outcome = 'YES';
              else if (noNum > 0n && yesNum === 0n) outcome = 'NO';
            }
          } catch {}
        }

        // Find our tokens for this condition
        const relatedPos = allPositions.find(p => p.conditionId === conditionId);
        const relatedTokens = nonZeroBalances.filter(t => {
          const tPos = allPositions.find(p => p.clobTokenIds?.includes(t.tokenId));
          return tPos?.conditionId === conditionId;
        });

        console.log(`\n  Market: ${question.slice(0, 70)}`);
        console.log(`    conditionId: ${conditionId}`);
        console.log(`    resolved: ${resolved ? 'YES' : 'NO'}`);
        console.log(`    outcome: ${outcome ?? 'not determined'}`);
        console.log(`    venue: ${relatedPos?.venue ?? 'unknown'}`);

        for (const tb of relatedTokens) {
          const won = outcome === tb.side;
          const status = !resolved ? 'ACTIVE' : won ? '💰 UNREDEEMED WINNER' : 'LOSS (worthless tokens)';
          console.log(`    ${tb.side} tokens: ${tb.balance.toFixed(4)} shares → ${status}`);
          if (won) {
            console.log(`    ⚠️  $${tb.balance.toFixed(2)} USDC claimable via redeemPositions()`);
          }
        }

        await new Promise(r => setTimeout(r, 300)); // rate limit
      } catch (err) {
        console.log(`  Error checking ${conditionId.slice(0, 12)}...: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // 6. Also check Simmer's /wallet endpoint for our address
  console.log('\n── Simmer wallet position scan ──');
  const SIMMER_KEY = process.env.SIMMER_API_KEY;
  if (SIMMER_KEY) {
    try {
      const resp = await fetch(
        `https://api.simmer.markets/api/sdk/wallet/${walletAddress}/positions`,
        { headers: { Authorization: `Bearer ${SIMMER_KEY}` }, signal: AbortSignal.timeout(15_000) },
      );
      if (resp.ok) {
        const data = await resp.json() as any;
        const positions = Array.isArray(data) ? data : (data?.positions ?? []);
        console.log(`Simmer sees ${positions.length} on-chain positions for this wallet`);
        let totalValue = 0;
        for (const p of positions) {
          const shares = p.shares ?? p.size ?? 0;
          const price = p.current_price ?? p.price ?? 0;
          const value = shares * price;
          totalValue += value;
          if (shares > 0.001) {
            console.log(`  shares=${Number(shares).toFixed(4)} | price=$${Number(price).toFixed(4)} | value=$${value.toFixed(2)} | ${(p.question ?? p.market ?? p.token_id ?? '?').toString().slice(0, 60)}`);
          }
        }
        console.log(`  Total mark-to-market: $${totalValue.toFixed(2)}`);
      } else {
        console.log(`Simmer wallet endpoint returned HTTP ${resp.status}`);
      }
    } catch (err) {
      console.log(`Simmer wallet check failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 7. Check for stale redeemer keys in Redis
  console.log('\n── Redis redeemer state ──');
  const redeemerKeys = await redis.keys('redeemer:*');
  console.log(`Redeemer keys: ${redeemerKeys.length}`);
  for (const key of redeemerKeys.slice(0, 20)) {
    const type = await redis.type(key);
    if (type === 'hash') {
      const val = await redis.hgetall(key);
      console.log(`  ${key}: ${JSON.stringify(val)}`);
    } else if (type === 'set') {
      const members = await redis.smembers(key);
      console.log(`  ${key}: [${members.length} members] ${members.slice(0, 3).join(', ')}${members.length > 3 ? '...' : ''}`);
    } else if (type === 'string') {
      const val = await redis.get(key);
      console.log(`  ${key}: ${val}`);
    }
  }

  // 8. Summary
  console.log('\n=== CLOB RECONCILIATION SUMMARY ===');
  console.log(`  On-chain USDC.e:           $${usdcBalance.toFixed(6)}`);
  console.log(`  MATIC for gas:             ${maticBalance.toFixed(6)}`);
  console.log(`  Redis CLOB positions:      ${clobPositions.length}`);
  console.log(`  On-chain tokens w/balance: ${nonZeroBalances.length}`);
  const totalTokenValue = nonZeroBalances.reduce((sum, t) => sum + t.balance, 0);
  console.log(`  Total token shares held:   ${totalTokenValue.toFixed(4)}`);
  console.log('\nIf any tokens show "UNREDEEMED WINNER" above, run the redeemer or');
  console.log('call redeemPositions() on the CTF contract to claim them.');

  redis.disconnect();
}

main().catch((err) => {
  console.error('Audit failed:', err);
  process.exit(1);
});
