#!/usr/bin/env npx tsx
/**
 * CLOB allowance diagnostics probe.
 *
 * Purpose:
 * - show exact signer/funder/signature_type tuple
 * - load API credentials from Redis cache (avoids cold-start 400 on re-derivation)
 * - force allowance refresh via /balance-allowance/update
 * - read raw + normalized balance/allowance from /balance-allowance
 *
 * Usage:
 *   npm run probe:clob-allowance
 *
 * Optional env overrides:
 *   PROBE_SIGNATURE_TYPE=0|1|2
 *   PROBE_FUNDER_ADDRESS=0x...
 *   PROBE_FORCE_REDERIVE=1   # skip Redis cache, force fresh createOrDeriveApiKey
 */

import 'dotenv/config';
import { Wallet } from '@ethersproject/wallet';
import { AssetType, ClobClient } from '@polymarket/clob-client';
import type { ApiKeyCreds } from '@polymarket/clob-client';
import { Redis } from 'ioredis';
import { loadConfig } from '../src/shared/config.js';

const HOST = 'https://clob.polymarket.com';
const CHAIN_ID = 137;
const USDC_BASE = 1_000_000;
const CLOB_CREDS_REDIS_KEY = 'clob:api_creds';

function toUsdc(raw?: string): number {
  // Raw values from Polymarket API are in USDC base units (6 decimals).
  return Number(raw ?? '0') / USDC_BASE;
}

async function loadCredsFromRedis(redis: Redis): Promise<ApiKeyCreds | null> {
  try {
    const raw = await redis.get(CLOB_CREDS_REDIS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed &&
      typeof parsed === 'object' &&
      'key' in parsed &&
      'secret' in parsed &&
      'passphrase' in parsed
    ) {
      return parsed as ApiKeyCreds;
    }
    return null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.POLYGON_WALLET_PRIVATE_KEY) {
    throw new Error('POLYGON_WALLET_PRIVATE_KEY is required');
  }

  const signer = new Wallet(cfg.POLYGON_WALLET_PRIVATE_KEY);
  const signatureType = Number(
    process.env.PROBE_SIGNATURE_TYPE ?? cfg.POLYMARKET_SIGNATURE_TYPE,
  ) as 0 | 1 | 2;
  const funderAddress =
    process.env.PROBE_FUNDER_ADDRESS ?? cfg.POLYMARKET_FUNDER_ADDRESS ?? signer.address;
  const forceRederive = process.env.PROBE_FORCE_REDERIVE === '1';

  console.log('=== CLOB Allowance Probe ===');
  console.log('host           :', HOST);
  console.log('chainId        :', CHAIN_ID);
  console.log('signer         :', signer.address);
  console.log('funder         :', funderAddress);
  console.log('signatureType  :', signatureType);

  // Connect to Redis to retrieve cached creds
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) throw new Error('REDIS_URL is required');
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: 2, lazyConnect: true });

  let creds: ApiKeyCreds | null = null;

  if (!forceRederive) {
    console.log('\n[1/3] loading API credentials from Redis cache...');
    creds = await loadCredsFromRedis(redis);
    if (creds) {
      console.log('apiKey prefix  :', `${creds.key.slice(0, 8)}... (loaded from Redis)`);
    } else {
      console.log('No cached creds found in Redis.');
    }
  }

  if (!creds) {
    console.log('\n[1/3] deriving API credentials from Polymarket (createOrDeriveApiKey)...');
    const bootstrap = new ClobClient(
      HOST,
      CHAIN_ID,
      signer,
      undefined,
      signatureType,
      funderAddress,
    );
    const derived = await bootstrap.createOrDeriveApiKey();
    if (!derived?.key) {
      throw new Error(
        'createOrDeriveApiKey returned empty/undefined — check sig type and funder address',
      );
    }
    creds = derived;
    // Persist for future runs
    await redis.set(CLOB_CREDS_REDIS_KEY, JSON.stringify(creds), 'EX', 23 * 3600);
    console.log('apiKey prefix  :', `${creds.key.slice(0, 8)}... (derived fresh, cached to Redis)`);
  }

  const client = new ClobClient(HOST, CHAIN_ID, signer, creds, signatureType, funderAddress);

  const typed = client as unknown as {
    updateBalanceAllowance(params?: { asset_type?: string }): Promise<unknown>;
    getBalanceAllowance(params: {
      asset_type: string;
    }): Promise<{ balance?: string; allowance?: string }>;
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

  const balanceOk = toUsdc(raw.balance) > 0;
  const allowanceOk = toUsdc(raw.allowance) > 0;

  if (balanceOk) {
    console.log('\n✅ Balance is funded — CLOB trading ready.');
    if (!allowanceOk) {
      console.log(
        '   (allowance=0 is normal for POLY_PROXY accounts — proxy accesses funds directly)',
      );
    }
  } else {
    console.log('\n⚠️  Balance is zero — fund your Polymarket wallet before trading.');
  }

  await redis.quit();
  console.log('\nDone.');
}

main().catch((err: unknown) => {
  console.error('Probe failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
