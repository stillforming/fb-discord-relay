/**
 * Integration test setup
 * Uses a test database and mocks external APIs
 */
import { PrismaClient } from '@prisma/client';
import { beforeAll, afterAll, beforeEach } from 'vitest';

// Use test database
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 
  'postgresql://relay:relay@localhost:5432/relay_test';

// Set required env vars for tests
process.env.META_VERIFY_TOKEN = 'test-verify-token';
process.env.META_APP_SECRET = 'test-app-secret-12345';
process.env.META_GRAPH_VERSION = 'v21.0';
process.env.META_PAGE_ID = '123456789';
process.env.META_PAGE_ACCESS_TOKEN = 'test-page-token';
process.env.DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/test/test';
process.env.TRIGGER_TAG = '#discord';
process.env.ALERTS_ENABLED = 'true';
process.env.LOG_LEVEL = 'error'; // Quiet logs during tests

export const prisma = new PrismaClient();

/**
 * Setup: ensure database is ready
 */
export async function setupTestDatabase() {
  try {
    // Push schema to test database
    const { execSync } = await import('child_process');
    execSync('npx prisma db push --force-reset --skip-generate', {
      stdio: 'pipe',
      env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL },
    });
  } catch (err) {
    console.error('Failed to setup test database. Is Postgres running?');
    throw err;
  }
}

/**
 * Cleanup: clear all data between tests
 */
export async function cleanupTestData() {
  await prisma.postEvent.deleteMany();
  await prisma.deliveryLog.deleteMany();
  await prisma.post.deleteMany();
}

/**
 * Teardown: disconnect
 */
export async function teardownTestDatabase() {
  await prisma.$disconnect();
}
