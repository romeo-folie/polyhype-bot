
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import input from 'input'; // GramJS-friendly input helper
import 'dotenv/config';

async function reauth() {
  const apiId = Number(process.env.TELEGRAM_API_ID);
  const apiHash = process.env.TELEGRAM_API_HASH;

  if (!apiId || !apiHash) {
    console.error('Missing TELEGRAM_API_ID or TELEGRAM_API_HASH in .env');
    return;
  }

  console.log('\n--- Telegram Re-authentication Utility ---');
  console.log('This will generate a fresh TELEGRAM_SESSION_STRING for your .env\n');

  const client = new TelegramClient(new StringSession(''), apiId, apiHash, {
    connectionRetries: 5,
  });

  await client.start({
    phoneNumber: async () => await input.text('Phone number (with country code): '),
    password: async () => await input.text('Password (if 2FA enabled): '),
    phoneCode: async () => await input.text('Code from Telegram: '),
    onError: (err) => console.error(err),
  });

  const sessionString = client.session.save() as unknown as string;
  
  console.log('\n✅ Login Successful!');
  console.log('\nCopy and paste this into your .env as TELEGRAM_SESSION_STRING:');
  console.log('------------------------------------------------------------');
  console.log(sessionString);
  console.log('------------------------------------------------------------\n');
  
  await client.disconnect();
}

reauth().catch(console.error);
