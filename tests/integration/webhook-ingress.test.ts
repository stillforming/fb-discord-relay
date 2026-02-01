/**
 * Integration tests for webhook ingress
 * Tests the full Fastify request → database → queue flow
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createHmac } from 'crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { prisma, setupTestDatabase, cleanupTestData, teardownTestDatabase } from './setup.js';

// Mock pg-boss before importing routes
vi.mock('pg-boss', () => {
  return {
    default: class MockPgBoss {
      constructor() {}
      async start() {}
      async stop() {}
      async send(queue: string, data: any, options: any) {
        return 'mock-job-id';
      }
      on() {}
    },
  };
});

// Now import the routes
const { metaWebhookRoutes } = await import('../../src/ingress/routes/meta-webhook.js');
const { healthRoutes } = await import('../../src/ingress/routes/health.js');

describe('Webhook Ingress Integration', () => {
  let app: FastifyInstance;
  const APP_SECRET = 'test-app-secret-12345';
  const VERIFY_TOKEN = 'test-verify-token';

  function createSignature(body: string): string {
    const hmac = createHmac('sha256', APP_SECRET);
    hmac.update(body);
    return 'sha256=' + hmac.digest('hex');
  }

  beforeAll(async () => {
    await setupTestDatabase();

    // Create Fastify app
    app = Fastify({ logger: false });

    // Add raw body parser
    app.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer' },
      (req, body, done) => {
        (req as any).rawBody = body;
        try {
          const json = JSON.parse(body.toString());
          done(null, json);
        } catch (err) {
          done(err as Error, undefined);
        }
      }
    );

    await app.register(healthRoutes);
    await app.register(metaWebhookRoutes, { prefix: '/meta' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await teardownTestDatabase();
  });

  beforeEach(async () => {
    await cleanupTestData();
  });

  describe('GET /meta/webhook (verification)', () => {
    it('should return challenge on valid verification request', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/meta/webhook',
        query: {
          'hub.mode': 'subscribe',
          'hub.verify_token': VERIFY_TOKEN,
          'hub.challenge': 'test-challenge-123',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toBe('test-challenge-123');
    });

    it('should reject invalid verify token', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/meta/webhook',
        query: {
          'hub.mode': 'subscribe',
          'hub.verify_token': 'wrong-token',
          'hub.challenge': 'test-challenge-123',
        },
      });

      expect(response.statusCode).toBe(403);
    });

    it('should reject invalid mode', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/meta/webhook',
        query: {
          'hub.mode': 'unsubscribe',
          'hub.verify_token': VERIFY_TOKEN,
          'hub.challenge': 'test-challenge-123',
        },
      });

      expect(response.statusCode).toBe(403);
    });
  });

  describe('POST /meta/webhook (events)', () => {
    it('should reject request without signature', async () => {
      const body = JSON.stringify({
        object: 'page',
        entry: [],
      });

      const response = await app.inject({
        method: 'POST',
        url: '/meta/webhook',
        headers: {
          'content-type': 'application/json',
        },
        payload: body,
      });

      expect(response.statusCode).toBe(403);
    });

    it('should reject request with invalid signature', async () => {
      const body = JSON.stringify({
        object: 'page',
        entry: [],
      });

      const response = await app.inject({
        method: 'POST',
        url: '/meta/webhook',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': 'sha256=invalid',
        },
        payload: body,
      });

      expect(response.statusCode).toBe(403);
    });

    it('should accept valid webhook and create post record', async () => {
      const body = JSON.stringify({
        object: 'page',
        entry: [
          {
            id: '123456789',
            time: Date.now(),
            changes: [
              {
                field: 'feed',
                value: {
                  post_id: '123456789_987654321',
                  verb: 'add',
                  item: 'post',
                },
              },
            ],
          },
        ],
      });

      const response = await app.inject({
        method: 'POST',
        url: '/meta/webhook',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': createSignature(body),
        },
        payload: body,
      });

      expect(response.statusCode).toBe(200);

      // Verify post was created in database
      const post = await prisma.post.findUnique({
        where: { fbPostId: '123456789_987654321' },
      });

      expect(post).not.toBeNull();
      expect(post?.status).toBe('received');
    });

    it('should ignore non-add verbs', async () => {
      const body = JSON.stringify({
        object: 'page',
        entry: [
          {
            id: '123456789',
            time: Date.now(),
            changes: [
              {
                field: 'feed',
                value: {
                  post_id: '123456789_edit123',
                  verb: 'edit', // Should be ignored
                  item: 'post',
                },
              },
            ],
          },
        ],
      });

      const response = await app.inject({
        method: 'POST',
        url: '/meta/webhook',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': createSignature(body),
        },
        payload: body,
      });

      expect(response.statusCode).toBe(200);

      // Verify no post was created
      const post = await prisma.post.findUnique({
        where: { fbPostId: '123456789_edit123' },
      });

      expect(post).toBeNull();
    });

    it('should deduplicate repeated webhooks', async () => {
      const body = JSON.stringify({
        object: 'page',
        entry: [
          {
            id: '123456789',
            time: Date.now(),
            changes: [
              {
                field: 'feed',
                value: {
                  post_id: '123456789_dupe123',
                  verb: 'add',
                  item: 'post',
                },
              },
            ],
          },
        ],
      });

      // Send twice
      await app.inject({
        method: 'POST',
        url: '/meta/webhook',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': createSignature(body),
        },
        payload: body,
      });

      await app.inject({
        method: 'POST',
        url: '/meta/webhook',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': createSignature(body),
        },
        payload: body,
      });

      // Should only have one post
      const posts = await prisma.post.findMany({
        where: { fbPostId: '123456789_dupe123' },
      });

      expect(posts.length).toBe(1);
    });
  });

  describe('GET /healthz', () => {
    it('should return healthy when database is connected', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/healthz',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.status).toBe('healthy');
    });
  });
});
