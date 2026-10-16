#!/usr/bin/env node
const { execSync } = require('child_process');
require('dotenv').config();

if (process.env.CONFIRM_SUPABASE_DEPLOY !== 'yes') {
  console.error(
    'Refusing to deploy migrations to Supabase: CONFIRM_SUPABASE_DEPLOY=yes is not set.',
  );
  process.exit(1);
}

const supabaseDirectUrl = process.env.SUPABASE_DIRECT_URL;
if (!supabaseDirectUrl) {
  console.error(
    'SUPABASE_DIRECT_URL is not defined in the environment. Cannot deploy.',
  );
  process.exit(1);
}

console.log('Deploying migrations to Supabase project (<redacted_host>)...');

try {
  const result = execSync('npx.cmd prisma migrate deploy', {
    env: {
      ...process.env,
      DIRECT_URL: supabaseDirectUrl,
      DATABASE_URL: process.env.SUPABASE_DATABASE_URL || supabaseDirectUrl,
    },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const redact = (str) =>
    (str || '').replace(/postgresql:\/\/[^@]+@[^/]+/g, 'postgresql://<redacted>');

  console.log(redact(result));
  console.log('Supabase migration deploy completed successfully.');
} catch (err) {
  const redact = (str) =>
    (str || '').replace(/postgresql:\/\/[^@]+@[^:\s\/]+(:[0-9]+)?/g, 'postgresql://<redacted>');
  if (err.stdout) console.log(redact(err.stdout.toString()));
  if (err.stderr) console.error(redact(err.stderr.toString()));
  console.error('Supabase migration deploy failed with exit code:', err.status);
  process.exit(err.status || 1);
}
