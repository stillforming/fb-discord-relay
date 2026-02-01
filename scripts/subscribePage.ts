#!/usr/bin/env tsx
/**
 * Subscribe a Facebook Page to receive webhook events
 * 
 * Usage:
 *   npx tsx scripts/subscribePage.ts
 *   npx tsx scripts/subscribePage.ts --verify
 * 
 * Requires environment variables:
 *   - META_PAGE_ID
 *   - META_PAGE_ACCESS_TOKEN
 *   - META_APP_SECRET
 *   - META_GRAPH_VERSION
 */

import { createHmac } from 'crypto';

// Load env manually since we're not using the full app
import { config as dotenvConfig } from 'dotenv';
dotenvConfig();

const META_PAGE_ID = process.env.META_PAGE_ID!;
const META_PAGE_ACCESS_TOKEN = process.env.META_PAGE_ACCESS_TOKEN!;
const META_APP_SECRET = process.env.META_APP_SECRET!;
const META_GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v21.0';

function generateAppSecretProof(accessToken: string): string {
  const hmac = createHmac('sha256', META_APP_SECRET);
  hmac.update(accessToken);
  return hmac.digest('hex');
}

async function verifySubscription(): Promise<boolean> {
  console.log('📋 Checking current subscriptions...\n');

  const url = new URL(
    `https://graph.facebook.com/${META_GRAPH_VERSION}/${META_PAGE_ID}/subscribed_apps`
  );
  url.searchParams.set('access_token', META_PAGE_ACCESS_TOKEN);
  url.searchParams.set('appsecret_proof', generateAppSecretProof(META_PAGE_ACCESS_TOKEN));

  const response = await fetch(url.toString());
  const data = await response.json();

  if (!response.ok) {
    console.error('❌ Failed to get subscriptions:', data.error?.message || data);
    return false;
  }

  if (data.data?.length === 0) {
    console.log('⚠️ No apps subscribed to this page.');
    return false;
  }

  console.log('✅ Subscribed apps:');
  for (const app of data.data) {
    console.log(`  - ${app.name || app.id}`);
    if (app.subscribed_fields) {
      console.log(`    Fields: ${app.subscribed_fields.join(', ')}`);
    }
  }

  return true;
}

async function subscribe(): Promise<boolean> {
  console.log('📡 Subscribing app to page feed events...\n');

  const url = new URL(
    `https://graph.facebook.com/${META_GRAPH_VERSION}/${META_PAGE_ID}/subscribed_apps`
  );

  const params = new URLSearchParams();
  params.set('access_token', META_PAGE_ACCESS_TOKEN);
  params.set('appsecret_proof', generateAppSecretProof(META_PAGE_ACCESS_TOKEN));
  params.set('subscribed_fields', 'feed');

  const response = await fetch(url.toString(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });

  const data = await response.json();

  if (!response.ok) {
    console.error('❌ Subscription failed:', data.error?.message || data);
    
    // Common errors
    if (data.error?.code === 190) {
      console.error('\n💡 Token may be expired. Generate a new Page Access Token.');
    } else if (data.error?.code === 200) {
      console.error('\n💡 Missing permissions. Ensure the app has pages_manage_metadata permission.');
    }
    
    return false;
  }

  if (data.success) {
    console.log('✅ Successfully subscribed to page feed events!');
    return true;
  }

  console.log('⚠️ Unexpected response:', data);
  return false;
}

async function main() {
  // Validate config
  if (!META_PAGE_ID || !META_PAGE_ACCESS_TOKEN || !META_APP_SECRET) {
    console.error('❌ Missing required environment variables.');
    console.error('   Required: META_PAGE_ID, META_PAGE_ACCESS_TOKEN, META_APP_SECRET');
    process.exit(1);
  }

  console.log('🔧 Configuration:');
  console.log(`   Page ID: ${META_PAGE_ID}`);
  console.log(`   Graph Version: ${META_GRAPH_VERSION}`);
  console.log(`   Token: ${META_PAGE_ACCESS_TOKEN.slice(0, 10)}...`);
  console.log('');

  const args = process.argv.slice(2);
  const verifyOnly = args.includes('--verify') || args.includes('-v');

  if (verifyOnly) {
    const ok = await verifySubscription();
    process.exit(ok ? 0 : 1);
  }

  // Subscribe, then verify
  const subscribed = await subscribe();
  if (!subscribed) {
    process.exit(1);
  }

  console.log('');
  await verifySubscription();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
