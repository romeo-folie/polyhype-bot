import 'dotenv/config';
import { ethers } from 'ethers';
import { loadConfig } from '../src/shared/config.js';

const USDC_TOKEN_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'; // USDC.e on Polygon

const ERC20_ABI = [
  'function balanceWith(address account) view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
];

async function main() {
  const cfg = loadConfig();
  if (!cfg.POLYGON_WALLET_PRIVATE_KEY) {
    console.error('POLYGON_WALLET_PRIVATE_KEY missing from .env');
    return;
  }

  const provider = new ethers.JsonRpcProvider('https://polygon-rpc.com');
  const signer = new ethers.Wallet(cfg.POLYGON_WALLET_PRIVATE_KEY, provider);
  const signatureType = cfg.POLYMARKET_SIGNATURE_TYPE ?? 0;
  const funderAddress = cfg.POLYMARKET_FUNDER_ADDRESS ?? signer.address;

  console.log('\n--- Wallet Configuration ---');
  console.log(`Signer Address  : ${signer.address}`);
  console.log(`Funder Address  : ${funderAddress} ${signatureType === 1 ? '(Proxy)' : '(EOA)'}`);
  console.log(`Signature Type  : ${signatureType}`);

  console.log('\n--- Native Balance (POL/Matic) ---');
  const signerPol = await provider.getBalance(signer.address);
  console.log(`Signer (Gas)    : ${ethers.formatEther(signerPol)} POL`);
  
  if (funderAddress !== signer.address) {
    const funderPol = await provider.getBalance(funderAddress);
    console.log(`Funder (Proxy)  : ${ethers.formatEther(funderPol)} POL`);
  }

  console.log('\n--- Token Balance (USDC.e) ---');
  const usdc = new ethers.Contract(USDC_TOKEN_ADDRESS, ERC20_ABI, provider);
  
  try {
    const signerUsdc = await usdc.balanceOf(signer.address);
    const funderUsdc = await usdc.balanceOf(funderAddress);
    
    console.log(`Signer (EOA)    : ${ethers.formatUnits(signerUsdc, 6)} USDC`);
    if (funderAddress !== signer.address) {
      console.log(`Funder (Proxy)  : ${ethers.formatUnits(funderUsdc, 6)} USDC`);
    }
  } catch (err) {
    console.log('Error fetching USDC balance:', (err as any).message);
  }

  console.log('\n--- Status ---');
  if (Number(ethers.formatEther(signerPol)) < 0.05) {
    console.log('⚠️  LOW GAS: You have less than 0.05 POL. Redemptions might fail.');
  } else {
    console.log('✅ GAS READY: You have enough POL for automated redemptions.');
  }

  process.exit(0);
}

main().catch(err => {
  console.error('Check failed:', err);
  process.exit(1);
});
