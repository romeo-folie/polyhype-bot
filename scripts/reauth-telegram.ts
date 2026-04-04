
import { createClient, configure } from 'tdl';
import { getTdjson } from 'prebuilt-tdlib';
import 'dotenv/config';
import path from 'path';

configure({ tdjson: getTdjson() });

async function reauth() {
  const apiId = Number(process.env.TELEGRAM_API_ID);
  const apiHash = process.env.TELEGRAM_API_HASH;
  const dbPath = process.env.TELEGRAM_DB_PATH || './tdlib-data';

  if (!apiId || !apiHash) {
    console.error('Missing TELEGRAM_API_ID or TELEGRAM_API_HASH in .env');
    return;
  }

  console.log('\n--- Telegram Re-authentication Utility (TDLib) ---');
  console.log(`Session will be stored in: ${path.resolve(dbPath)}\n`);

  const client = createClient({
    apiId,
    apiHash,
    databaseDirectory: dbPath,
  });

  client.on('error', console.error);

  try {
    await client.login();
    console.log('\n✅ Login Successful!');
    console.log('The session is now persisted in your database directory.');
    console.log('You can now start the monitor without any session string.\n');
  } catch (err: unknown) {
    console.error('\n❌ Login failed:', err);
  } finally {
    await client.close();
  }
}

reauth().catch((err: unknown) => {
  console.error(err);
});
