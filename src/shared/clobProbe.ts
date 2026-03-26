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

const SIG_TYPE_LABELS: Record<number, string> = {
  0: 'EOA',
  1: 'POLY_PROXY',
  2: 'POLY_GNOSIS_SAFE',
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

  const bootstrap = new ClobClient(CLOB_HOST, POLYGON_CHAIN_ID, signer);
  const creds = await bootstrap.createOrDeriveApiKey();

  const client = new ClobClient(
    CLOB_HOST,
    POLYGON_CHAIN_ID,
    signer,
    creds,
    sigType,
    funderAddress,
  );

  // Balance + allowance
  const balResult = await (client as unknown as {
    getBalanceAllowance(params: { asset_type: string }): Promise<{ balance?: string; allowance?: string }>;
  }).getBalanceAllowance({ asset_type: AssetType.COLLATERAL });

  const balance = parseFloat(balResult.balance ?? '0');
  const allowance = parseFloat(balResult.allowance ?? '0');

  logger.info('[clob-probe] USDC collateral balance', { balance });
  logger.info('[clob-probe] USDC allowance', { allowance });

  if (balance === 0 && allowance === 0) {
    logger.warn('[clob-probe] both balance and allowance are zero — CLOB trades will fail');
  }

  // Open orders
  const openOrders = await client.getOpenOrders();
  logger.info('[clob-probe] open CLOB orders', { count: openOrders.length });
}
