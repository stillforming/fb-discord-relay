/**
 * Integration tests for worker post processing
 * Tests the fetch → check tag → send flow with mocked external APIs
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi, type Mock } from 'vitest';
import { prisma, setupTestDatabase, cleanupTestData, teardownTestDatabase } from './setup.js';
import { PostStatus } from '@prisma/client';

// Mock fetch for external API calls
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Import after setting up mocks
const { processPost } = await import('../../src/worker/handlers/process-post.js');
const { getOrCreatePost } = await import('../../src/services/post-state.js');

// Create a mock logger
const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: () => mockLogger,
};

describe('Worker Processing Integration', () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });

  afterAll(async () => {
    await teardownTestDatabase();
  });

  beforeEach(async () => {
    await cleanupTestData();
    mockFetch.mockReset();
    vi.clearAllMocks();
  });

  describe('processPost', () => {
    it('should deliver post with trigger tag', async () => {
      // Create post in database
      const fbPostId = '123_with_tag';
      await getOrCreatePost(fbPostId);

      // Mock Facebook Graph API response
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: fbPostId,
          message: 'Buy AAPL at $150 #discord',
          permalink_url: 'https://facebook.com/post/123',
          created_time: '2025-01-31T12:00:00Z',
          from: { id: '123456789', name: 'Test Page' },
        }),
      });

      // Mock Discord webhook response
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 'discord-msg-123' }),
      });

      await processPost(fbPostId, mockLogger as any);

      // Verify final state
      const post = await prisma.post.findUnique({
        where: { fbPostId },
        include: { events: true },
      });

      expect(post?.status).toBe(PostStatus.delivered);
      expect(post?.discordMsgId).toBe('discord-msg-123');
      expect(post?.message).toBe('Buy AAPL at $150 #discord');
    });

    it('should ignore post without trigger tag', async () => {
      const fbPostId = '123_no_tag';
      await getOrCreatePost(fbPostId);

      // Mock Facebook Graph API response (no #discord tag)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: fbPostId,
          message: 'Just a regular post without the tag',
          from: { id: '123456789', name: 'Test Page' },
        }),
      });

      await processPost(fbPostId, mockLogger as any);

      const post = await prisma.post.findUnique({ where: { fbPostId } });

      expect(post?.status).toBe(PostStatus.ignored);
      
      // Discord should NOT have been called
      expect(mockFetch).toHaveBeenCalledTimes(1); // Only Facebook
    });

    it('should mark as failed on non-retryable Facebook error', async () => {
      const fbPostId = '123_not_found';
      await getOrCreatePost(fbPostId);

      // Mock Facebook 404 response
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: async () => ({
          error: { message: 'Post not found', code: 100 },
        }),
      });

      await processPost(fbPostId, mockLogger as any);

      const post = await prisma.post.findUnique({ where: { fbPostId } });

      expect(post?.status).toBe(PostStatus.failed);
      expect(post?.lastError).toContain('Post not found');
    });

    it('should throw for retryable Facebook error (triggers pg-boss retry)', async () => {
      const fbPostId = '123_temp_error';
      await getOrCreatePost(fbPostId);

      // Mock Facebook 500 response
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({
          error: { message: 'Internal error', code: 1 },
        }),
      });

      await expect(processPost(fbPostId, mockLogger as any)).rejects.toThrow('Retryable');

      const post = await prisma.post.findUnique({ where: { fbPostId } });

      // Should be back to received for retry
      expect(post?.status).toBe(PostStatus.received);
      expect(post?.retryCount).toBe(1);
    });

    it('should mark as needs_review on ambiguous Discord delivery', async () => {
      const fbPostId = '123_ambiguous';
      await getOrCreatePost(fbPostId);

      // Mock Facebook success
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: fbPostId,
          message: 'Trade alert #discord',
          from: { id: '123456789', name: 'Test Page' },
        }),
      });

      // Mock Discord timeout (AbortError)
      const abortError = new Error('Aborted');
      abortError.name = 'AbortError';
      mockFetch.mockRejectedValueOnce(abortError);

      await processPost(fbPostId, mockLogger as any);

      const post = await prisma.post.findUnique({ where: { fbPostId } });

      expect(post?.status).toBe(PostStatus.needs_review);
    });

    it('should handle Discord rate limiting', async () => {
      const fbPostId = '123_rate_limited';
      await getOrCreatePost(fbPostId);

      // Mock Facebook success
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: fbPostId,
          message: 'Trade alert #discord',
          from: { id: '123456789', name: 'Test Page' },
        }),
      });

      // Mock Discord 429
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: new Map([['retry-after', '5']]),
        text: async () => 'Rate limited',
      });

      await expect(processPost(fbPostId, mockLogger as any)).rejects.toThrow('Retryable');

      const post = await prisma.post.findUnique({ where: { fbPostId } });

      expect(post?.status).toBe(PostStatus.received); // Back for retry
    });

    it('should skip already delivered posts', async () => {
      const fbPostId = '123_already_done';
      
      // Create and manually mark as delivered
      await prisma.post.create({
        data: {
          fbPostId,
          status: PostStatus.delivered,
          discordMsgId: 'already-sent',
          deliveredAt: new Date(),
        },
      });

      await processPost(fbPostId, mockLogger as any);

      // Should not have called any external APIs
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should reject posts not from configured page', async () => {
      const fbPostId = '123_wrong_page';
      await getOrCreatePost(fbPostId);

      // Mock Facebook response with different page ID
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: fbPostId,
          message: 'Trade alert #discord',
          from: { id: '999999999', name: 'Wrong Page' }, // Different from META_PAGE_ID
        }),
      });

      await processPost(fbPostId, mockLogger as any);

      const post = await prisma.post.findUnique({ where: { fbPostId } });

      expect(post?.status).toBe(PostStatus.failed);
      expect(post?.lastError).toContain('not from configured page');
    });
  });

  describe('State machine integrity', () => {
    it('should record events for each state transition', async () => {
      const fbPostId = '123_events';
      await getOrCreatePost(fbPostId);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: fbPostId,
          message: 'Alert #discord',
          from: { id: '123456789', name: 'Test Page' },
        }),
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'msg-123' }),
      });

      await processPost(fbPostId, mockLogger as any);

      const post = await prisma.post.findUnique({
        where: { fbPostId },
        include: { events: { orderBy: { createdAt: 'asc' } } },
      });

      const eventTypes = post?.events.map((e) => e.event);

      expect(eventTypes).toContain('webhook_received');
      expect(eventTypes).toContain('status_fetching');
      expect(eventTypes).toContain('status_eligible');
      expect(eventTypes).toContain('status_sending');
      expect(eventTypes).toContain('status_delivered');
    });

    it('should log delivery to delivery_logs table', async () => {
      const fbPostId = '123_delivery_log';
      await getOrCreatePost(fbPostId);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: fbPostId,
          message: 'Alert #discord',
          from: { id: '123456789', name: 'Test Page' },
        }),
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'msg-456' }),
      });

      await processPost(fbPostId, mockLogger as any);

      const logs = await prisma.deliveryLog.findMany({
        where: { fbPostId },
      });

      expect(logs.length).toBe(1);
      expect(logs[0].success).toBe(true);
      expect(logs[0].discordMsgId).toBe('msg-456');
      expect(logs[0].latencyMs).toBeGreaterThan(0);
    });
  });
});
