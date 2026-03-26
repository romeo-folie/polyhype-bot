/**
 * CLOB startup readiness probe.
 *
 * Logs key CLOB wallet/account state at process startup so operators can
 * verify configuration before the first trade cycle fires.
 *
 * Never throws — errors are caught and logged.
 */

import { Wallet } from '@ethersproject/wallet';
import { ClobClient, AssetType } from '@polymarket/clob-client';
import { loadConfig } from './config.js';
import { logger } from './logger.js';

const CLOB_HOST = 'https://clob.polymarket.com';
const POLYGON_CHAIN_ID = 137;
// USDC uses 6 decimal places; raw API values are in base units.
const USDC_BASE = 1_000_000;

const SIG_TYPE_LABELS: Record<number, string> = {
  0: 'EOA — direct MetaMask/hardware wallet private key',
  1: 'POLY_PROXY — Magic/Google OAuth proxy account',
  2: 'POLY_GNOSIS_SAFE — Gnosis Safe multisig',
};

export async function runClobProbe(): Promise<void> {
  const cfg = loadConfig();

  if (!cfg.CLOB_FALLBACK_ENABLED) {
    logger.warn('[clob-probe] CLOB_FALLBACK_ENABLED=false — skipping probe');
    return;
  }

  if (!cfg.POLYGON_WALLET_PRIVATE_KEY) {
    logger.warn('[clob-probe] POLYGON_WALLET_PRIVATE_KEY not set — skipping probe');
    return;
  }

  const signer = new Wallet(cfg.POLYGON_WALLET_PRIVATE_KEY);
  const sigType = cfg.POLYMARKET_SIGNATURE_TYPE;
  const funderAddress = cfg.POLYMARKET_FUNDER_ADDRESS ?? signer.address;

  logger.info('[clob-probe] signer address', { address: signer.address });
  logger.info('[clob-probe] funder address', { address: funderAddress });
  logger.info('[clob-probe] signature type', {
    type: sigType,
    label: SIG_TYPE_LABELS[sigType] ?? 'UNKNOWN',
  });

  // Bootstrap credential acquisition.
  // createOrDeriveApiKey() first tries to CREATE a key (returns 400 if one
  // already exists), then falls back to derivation. A 400 on create is
  // expected for existing accounts — we log it at debug, not as an error.
  const bootstrap = new ClobClient(CLOB_HOST, POLYGON_CHAIN_ID, signer);
  let creds: Awaited<ReturnType<typeof bootstrap.createOrDeriveApiKey>>;
  try {
    creds = await bootstrap.createOrDeriveApiKey();
    logger.info('[clob-probe] API credentials acquired');
  } catch (err) {
    logger.error('[clob-probe] failed to acquire API credentials — cannot continue probe', {
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  const client = new ClobClient(
    CLOB_HOST,
    POLYGON_CHAIN_ID,
    signer,
    creds,
    sigType,
    funderAddress,
  );

  const typedClient = client as unknown as {
    updateBalanceAllowance(params?: { asset_type?: string }): Promise<void>;
    getBalanceAllowance(params: { asset_type: string }): Promise<{ balance?: string; allowance?: string }>;
  };

  // Refresh on-chain allowance state before reading (#90).
  // A stale on-chain state often shows allowance=0 even when approved.
  try {
    await typedClient.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });
    logger.info('[clob-probe] allowance refreshed');
  } catch (err) {
    logger.warn('[clob-probe] allowance refresh failed — reading cached state', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Balance + allowance (normalised from base units to whole USDC) (#89).
  const balResult = await typedClient.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });

  const balanceUsdc = parseFloat(balResult.balance ?? '0') / USDC_BASE;
  const allowanceUsdc = parseFloat(balResult.allowance ?? '0') / USDC_BASE;

  logger.info('[clob-probe] USDC collateral balance', { balanceUsdc });
  logger.info('[clob-probe] USDC allowance', { allowanceUsdc });

  if (balanceUsdc === 0) {
    logger.warn('[clob-probe] USDC balance is zero — deposit required before CLOB trades');
  }
  if (allowanceUsdc === 0) {
    // POLY_PROXY accounts (sig type 1) return allowance=0 by design — the proxy
    // accesses funds directly without a standard ERC20 approve(). Not a blocker.
    logger.info('[clob-probe] USDC allowance is zero — normal for POLY_PROXY accounts (sig type 1)');
  }

  // Open orders
  const openOrders = await client.getOpenOrders();
  logger.info('[clob-probe] open CLOB orders', { count: openOrders.length });
}
