/**
 * Integration tests for database operations
 * Tests Prisma operations and state management
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { prisma, setupTestDatabase, cleanupTestData, teardownTestDatabase } from './setup.js';
import { PostStatus } from '@prisma/client';

// Import services
const { getOrCreatePost, transitionPost, markForRetry, logDelivery, getPendingPosts } = 
  await import('../../src/services/post-state.js');

describe('Database Integration', () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });

  afterAll(async () => {
    await teardownTestDatabase();
  });

  beforeEach(async () => {
    await cleanupTestData();
  });

  describe('getOrCreatePost', () => {
    it('should create new post with received status', async () => {
      const { post, created } = await getOrCreatePost('new_post_123');

      expect(created).toBe(true);
      expect(post.fbPostId).toBe('new_post_123');
      expect(post.status).toBe(PostStatus.received);
    });

    it('should return existing post without creating duplicate', async () => {
      // Create first
      const { post: first, created: createdFirst } = await getOrCreatePost('existing_123');
      expect(createdFirst).toBe(true);

      // Try to create again
      const { post: second, created: createdSecond } = await getOrCreatePost('existing_123');
      expect(createdSecond).toBe(false);
      expect(second.id).toBe(first.id);
    });

    it('should create event on new post', async () => {
      await getOrCreatePost('with_event_123');

      const post = await prisma.post.findUnique({
        where: { fbPostId: 'with_event_123' },
        include: { events: true },
      });

      expect(post?.events.length).toBe(1);
      expect(post?.events[0].event).toBe('webhook_received');
    });
  });

  describe('transitionPost', () => {
    it('should allow valid transition', async () => {
      await getOrCreatePost('transition_valid');

      const result = await transitionPost('transition_valid', PostStatus.fetching);

      expect(result?.status).toBe(PostStatus.fetching);
    });

    it('should reject invalid transition', async () => {
      await getOrCreatePost('transition_invalid');

      // Try to skip from received to delivered (invalid)
      const result = await transitionPost('transition_invalid', PostStatus.delivered);

      expect(result).toBeNull();

      // Should still be in received state
      const post = await prisma.post.findUnique({ where: { fbPostId: 'transition_invalid' } });
      expect(post?.status).toBe(PostStatus.received);
    });

    it('should update additional fields during transition', async () => {
      await getOrCreatePost('transition_update');
      await transitionPost('transition_update', PostStatus.fetching);

      const result = await transitionPost('transition_update', PostStatus.eligible, {
        message: 'Test message',
        permalink: 'https://facebook.com/test',
      });

      expect(result?.message).toBe('Test message');
      expect(result?.permalink).toBe('https://facebook.com/test');
    });

    it('should record event on transition', async () => {
      await getOrCreatePost('transition_event');
      await transitionPost('transition_event', PostStatus.fetching);

      const post = await prisma.post.findUnique({
        where: { fbPostId: 'transition_event' },
        include: { events: { orderBy: { createdAt: 'asc' } } },
      });

      expect(post?.events.length).toBe(2);
      expect(post?.events[1].event).toBe('status_fetching');
    });
  });

  describe('markForRetry', () => {
    it('should reset to received and increment retry count', async () => {
      await getOrCreatePost('retry_test');
      await transitionPost('retry_test', PostStatus.fetching);

      const result = await markForRetry('retry_test', 'Network error');

      expect(result?.status).toBe(PostStatus.received);
      expect(result?.retryCount).toBe(1);
      expect(result?.lastError).toBe('Network error');
    });

    it('should not retry already delivered posts', async () => {
      await prisma.post.create({
        data: {
          fbPostId: 'no_retry_delivered',
          status: PostStatus.delivered,
          discordMsgId: 'msg-123',
        },
      });

      const result = await markForRetry('no_retry_delivered', 'Should not happen');

      expect(result?.status).toBe(PostStatus.delivered); // Unchanged
    });

    it('should accumulate retry count', async () => {
      await getOrCreatePost('multi_retry');
      
      await markForRetry('multi_retry', 'Error 1');
      await markForRetry('multi_retry', 'Error 2');
      await markForRetry('multi_retry', 'Error 3');

      const post = await prisma.post.findUnique({ where: { fbPostId: 'multi_retry' } });

      expect(post?.retryCount).toBe(3);
      expect(post?.lastError).toBe('Error 3');
    });
  });

  describe('logDelivery', () => {
    it('should create delivery log entry', async () => {
      await logDelivery('log_test', true, 'msg-123', undefined, 150);

      const logs = await prisma.deliveryLog.findMany({ where: { fbPostId: 'log_test' } });

      expect(logs.length).toBe(1);
      expect(logs[0].success).toBe(true);
      expect(logs[0].discordMsgId).toBe('msg-123');
      expect(logs[0].latencyMs).toBe(150);
    });

    it('should log failed delivery with error', async () => {
      await logDelivery('log_fail', false, undefined, 'Rate limited', 50);

      const logs = await prisma.deliveryLog.findMany({ where: { fbPostId: 'log_fail' } });

      expect(logs[0].success).toBe(false);
      expect(logs[0].errorMessage).toBe('Rate limited');
    });
  });

  describe('getPendingPosts', () => {
    it('should return posts in non-terminal states', async () => {
      // Create posts in various states
      await prisma.post.createMany({
        data: [
          { fbPostId: 'pending_1', status: PostStatus.received },
          { fbPostId: 'pending_2', status: PostStatus.fetching },
          { fbPostId: 'done_1', status: PostStatus.delivered },
          { fbPostId: 'done_2', status: PostStatus.ignored },
          { fbPostId: 'pending_3', status: PostStatus.sending },
        ],
      });

      const pending = await getPendingPosts();

      expect(pending.length).toBe(3);
      expect(pending.map((p) => p.fbPostId).sort()).toEqual(
        ['pending_1', 'pending_2', 'pending_3'].sort()
      );
    });

    it('should respect limit', async () => {
      await prisma.post.createMany({
        data: Array.from({ length: 10 }, (_, i) => ({
          fbPostId: `limit_${i}`,
          status: PostStatus.received,
        })),
      });

      const pending = await getPendingPosts(5);

      expect(pending.length).toBe(5);
    });
  });

  describe('Concurrent operations', () => {
    it('should handle concurrent getOrCreatePost calls', async () => {
      // Simulate race condition
      const results = await Promise.all([
        getOrCreatePost('concurrent_123'),
        getOrCreatePost('concurrent_123'),
        getOrCreatePost('concurrent_123'),
      ]);

      // All should succeed
      expect(results.every((r) => r.post.fbPostId === 'concurrent_123')).toBe(true);

      // Only one should be marked as created
      const createdCount = results.filter((r) => r.created).length;
      expect(createdCount).toBe(1);

      // Only one post in database
      const posts = await prisma.post.findMany({ where: { fbPostId: 'concurrent_123' } });
      expect(posts.length).toBe(1);
    });
  });
});
