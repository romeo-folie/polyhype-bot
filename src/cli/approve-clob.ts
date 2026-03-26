/**
 * One-shot CLI command: approve the Polymarket CTF Exchange contract to spend USDC.
 *
 * Calls updateBalanceAllowance() which authenticates via your EOA (L2 headers)
 * and instructs Polymarket's backend to submit the on-chain ERC20 approval
 * from the proxy wallet.
 *
 * Run once after initial setup or if allowance drops to zero:
 *   npx tsx src/cli/approve-clob.ts
 */

import 'dotenv/config';
import { ClobClient, AssetType } from '@polymarket/clob-client';
import { Wallet } from '@ethersproject/wallet';
import { loadConfig } from '../shared/config.js';

const CLOB_HOST = 'https://clob.polymarket.com';
const POLYGON_CHAIN_ID = 137;

async function main(): Promise<void> {
  const cfg = loadConfig();

  if (!cfg.POLYGON_WALLET_PRIVATE_KEY) {
    console.error('Error: POLYGON_WALLET_PRIVATE_KEY is not set');
    process.exit(1);
  }

  const signer = new Wallet(cfg.POLYGON_WALLET_PRIVATE_KEY);
  const funderAddress = cfg.POLYMARKET_FUNDER_ADDRESS ?? signer.address;
  const sigType = cfg.POLYMARKET_SIGNATURE_TYPE;

  console.log('Signer address :', signer.address);
  console.log('Funder address :', funderAddress);
  console.log('Signature type :', sigType);
  console.log('');

  // Bootstrap: derive API creds with correct sig type + funder
  console.log('Deriving API credentials...');
  const bootstrap = new ClobClient(CLOB_HOST, POLYGON_CHAIN_ID, signer, undefined, sigType, funderAddress);
  const creds = await bootstrap.createOrDeriveApiKey();
  console.log('API credentials acquired.');
  console.log('');

  // Build authenticated client
  const client = new ClobClient(CLOB_HOST, POLYGON_CHAIN_ID, signer, creds, sigType, funderAddress);

  // Check current balance and allowance before
  console.log('Checking current balance/allowance...');
  const before = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
  console.log('  Balance  :', before.balance, 'USDC');
  console.log('  Allowance:', before.allowance, 'USDC');
  console.log('');

  if (parseFloat(before.allowance) > 0) {
    console.log('Allowance is already set. No action needed.');
    process.exit(0);
  }

  // Request allowance update from Polymarket backend
  console.log('Requesting allowance approval from Polymarket...');
  const result = await client.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });
  console.log('Response:', JSON.stringify(result, null, 2));
  console.log('');

  // Re-check after
  console.log('Re-checking balance/allowance...');
  const after = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
  console.log('  Balance  :', after.balance, 'USDC');
  console.log('  Allowance:', after.allowance, 'USDC');

  if (parseFloat(after.allowance) > 0) {
    console.log('');
    console.log('✅ Allowance approved. CLOB trading is ready.');
  } else {
    console.log('');
    console.log('⚠️  Allowance still zero after update. Check the response above for errors.');
  }
}

main().catch((err: unknown) => {
  console.error('Fatal error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
