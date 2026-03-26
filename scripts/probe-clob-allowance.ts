#!/usr/bin/env npx tsx
/**
 * CLOB allowance diagnostics probe.
 *
 * Purpose:
 * - show exact signer/funder/signature_type tuple
 * - force allowance refresh via /balance-allowance/update
 * - read raw + normalized balance/allowance from /balance-allowance
 *
 * Usage:
 *   npm run probe:clob-allowance
 *
 * Optional env overrides:
 *   PROBE_SIGNATURE_TYPE=0|1|2
 *   PROBE_FUNDER_ADDRESS=0x...
 */

import 'dotenv/config';
import { Wallet } from '@ethersproject/wallet';
import { AssetType, ClobClient } from '@polymarket/clob-client';
import { loadConfig } from '../src/shared/config.js';

const HOST = 'https://clob.polymarket.com';
const CHAIN_ID = 137;
const USDC_BASE = 1_000_000;

function toUsdc(raw?: string): number {
  return Number(raw ?? '0') / USDC_BASE;
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.POLYGON_WALLET_PRIVATE_KEY) {
    throw new Error('POLYGON_WALLET_PRIVATE_KEY is required');
  }

  const signer = new Wallet(cfg.POLYGON_WALLET_PRIVATE_KEY);
  const signatureType = Number(process.env.PROBE_SIGNATURE_TYPE ?? cfg.POLYMARKET_SIGNATURE_TYPE);
  const funderAddress = process.env.PROBE_FUNDER_ADDRESS ?? cfg.POLYMARKET_FUNDER_ADDRESS ?? signer.address;

  console.log('=== CLOB Allowance Probe ===');
  console.log('host           :', HOST);
  console.log('chainId        :', CHAIN_ID);
  console.log('signer         :', signer.address);
  console.log('funder         :', funderAddress);
  console.log('signatureType  :', signatureType);

  const bootstrap = new ClobClient(HOST, CHAIN_ID, signer, undefined, signatureType as 0 | 1 | 2, funderAddress);

  console.log('\n[1/3] acquire API credentials (createOrDeriveApiKey) ...');
  const creds = await bootstrap.createOrDeriveApiKey();
  console.log('apiKey prefix  :', `${creds.apiKey.slice(0, 8)}...`);

  const client = new ClobClient(
    HOST,
    CHAIN_ID,
    signer,
    creds,
    signatureType as 0 | 1 | 2,
    funderAddress,
  );

  const typed = client as unknown as {
    updateBalanceAllowance(params?: { asset_type?: string }): Promise<unknown>;
    getBalanceAllowance(params: { asset_type: string }): Promise<{ balance?: string; allowance?: string }>;
  };

  console.log('\n[2/3] refresh allowance state (GET /balance-allowance/update) ...');
  try {
    const refreshResp = await typed.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });
    console.log('refresh result :', JSON.stringify(refreshResp ?? { ok: true }));
  } catch (err) {
    console.log('refresh error  :', err instanceof Error ? err.message : String(err));
  }

  console.log('\n[3/3] read allowance state (GET /balance-allowance) ...');
  const raw = await typed.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });

  console.log('raw.balance    :', raw.balance ?? '0');
  console.log('raw.allowance  :', raw.allowance ?? '0');
  console.log('balanceUsdc    :', toUsdc(raw.balance));
  console.log('allowanceUsdc  :', toUsdc(raw.allowance));

  console.log('\nDone.');
}

main().catch((err: unknown) => {
  console.error('Probe failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
