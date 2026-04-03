/**
 * Environment Sync Utility.
 *
 * Safely appends missing keys from .env.example to your local .env file.
 * Preserves all existing values and comments in both files.
 */

import fs from 'node:fs';
import path from 'node:path';

const ENV_PATH = path.resolve(process.cwd(), '.env');
const EXAMPLE_PATH = path.resolve(process.cwd(), '.env.example');

function parseKeys(content: string): Set<string> {
  const keys = new Set<string>();
  const lines = content.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    // Match KEY=VALUE or # KEY=VALUE (optional space after #)
    const match = trimmed.match(/^(?:#\s*)?([A-Z0-9_]+)=/i);
    if (match?.[1]) {
      keys.add(match[1]);
    }
  }
  return keys;
}

function main() {
  if (!fs.existsSync(EXAMPLE_PATH)) {
    console.error('Error: .env.example not found.');
    process.exit(1);
  }

  if (!fs.existsSync(ENV_PATH)) {
    console.log('.env does not exist. Creating from .env.example...');
    fs.copyFileSync(EXAMPLE_PATH, ENV_PATH);
    console.log('.env created successfully.');
    return;
  }

  const exampleContent = fs.readFileSync(EXAMPLE_PATH, 'utf-8');
  const envContent = fs.readFileSync(ENV_PATH, 'utf-8');

  const exampleKeys = parseKeys(exampleContent);
  const envKeys = parseKeys(envContent);

  const missingKeys: string[] = [];
  const exampleLines = exampleContent.split('\n');

  for (const key of exampleKeys) {
    if (!envKeys.has(key)) {
      // Find the original line in .env.example to preserve its default value/comment status
      const originalLine = exampleLines.find((line) => {
        const trimmed = line.trim();
        return (
          trimmed.startsWith(key + '=') ||
          trimmed.startsWith('# ' + key + '=') ||
          trimmed.startsWith('#' + key + '=')
        );
      });

      if (originalLine) {
        missingKeys.push(originalLine);
      }
    }
  }

  if (missingKeys.length === 0) {
    console.log('✓ Your .env is already up to date with .env.example.');
    return;
  }

  console.log(`Found ${missingKeys.length} missing keys. Appending to .env...`);

  let newEnvContent = envContent;
  if (!newEnvContent.endsWith('\n')) {
    newEnvContent += '\n';
  }

  newEnvContent += `\n# ── Added by sync-env utility (${new Date().toISOString().split('T')[0] ?? ''}) ──\n`;
  newEnvContent += missingKeys.join('\n') + '\n';

  fs.writeFileSync(ENV_PATH, newEnvContent);

  console.log('Successfully added:');
  missingKeys.forEach((line) => console.log(`  + ${line.trim()}`));
  console.log('\nDone! Please review your .env to fill in any required secrets.');
}

main();
