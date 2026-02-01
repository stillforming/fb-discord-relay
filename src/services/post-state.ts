import { PrismaClient, PostStatus, type Post } from '@prisma/client';
import { logger } from '../logger.js';

const log = logger.child({ service: 'post-state' });

const prisma = new PrismaClient();

export { prisma, PostStatus };
export type { Post };

/**
 * Valid state transitions
 */
const VALID_TRANSITIONS: Record<PostStatus, PostStatus[]> = {
  received: ['fetching'],
  fetching: ['eligible', 'ignored', 'failed', 'received'], // back to received on retryable error
  eligible: ['sending'],
  sending: ['delivered', 'failed', 'needs_review'],
  // Terminal states
  delivered: [],
  ignored: [],
  failed: ['received'], // Allow retry from failed (manual intervention)
  needs_review: ['received'], // Allow manual retry
};

/**
 * Create or get a post record (idempotent)
 * Returns the post and whether it was newly created
 */
export async function getOrCreatePost(
  fbPostId: string
): Promise<{ post: Post; created: boolean }> {
  // Try to find existing
  const existing = await prisma.post.findUnique({
    where: { fbPostId },
  });

  if (existing) {
    return { post: existing, created: false };
  }

  // Create new
  try {
    const post = await prisma.post.create({
      data: {
        fbPostId,
        status: PostStatus.received,
        events: {
          create: {
            event: 'webhook_received',
            details: { timestamp: new Date().toISOString() },
          },
        },
      },
    });
    log.info({ fbPostId, postId: post.id }, 'Created new post record');
    return { post, created: true };
  } catch (err: unknown) {
    // Race condition: another process created it
    if (err instanceof Error && 'code' in err && err.code === 'P2002') {
      const post = await prisma.post.findUniqueOrThrow({
        where: { fbPostId },
      });
      return { post, created: false };
    }
    throw err;
  }
}

/**
 * Transition a post to a new status with validation
 */
export async function transitionPost(
  fbPostId: string,
  toStatus: PostStatus,
  updates: Partial<{
    authorId: string;
    authorName: string;
    message: string;
    permalink: string;
    createdAt: Date;
    discordMsgId: string;
    deliveredAt: Date;
    lastError: string;
    retryCount: number;
  }> = {},
  eventDetails?: Record<string, unknown>
): Promise<Post | null> {
  const post = await prisma.post.findUnique({ where: { fbPostId } });

  if (!post) {
    log.warn({ fbPostId, toStatus }, 'Cannot transition: post not found');
    return null;
  }

  const validNext = VALID_TRANSITIONS[post.status];
  if (!validNext.includes(toStatus)) {
    log.warn(
      { fbPostId, fromStatus: post.status, toStatus },
      'Invalid state transition'
    );
    return null;
  }

  const updated = await prisma.post.update({
    where: { fbPostId },
    data: {
      status: toStatus,
      ...updates,
      events: {
        create: {
          event: `status_${toStatus}`,
          details: (eventDetails ?? {}) as Record<string, unknown> & object,
        },
      },
    },
  });

  log.info({ fbPostId, fromStatus: post.status, toStatus }, 'Post status transitioned');
  return updated;
}

/**
 * Increment retry count and optionally reset to received for retry
 */
export async function markForRetry(
  fbPostId: string,
  error: string
): Promise<Post | null> {
  const post = await prisma.post.findUnique({ where: { fbPostId } });
  if (!post) return null;

  // Don't retry from terminal success states
  if (post.status === PostStatus.delivered) {
    log.warn({ fbPostId }, 'Cannot retry: post already delivered');
    return post;
  }

  const newRetryCount = post.retryCount + 1;

  return prisma.post.update({
    where: { fbPostId },
    data: {
      status: PostStatus.received,
      lastError: error,
      retryCount: newRetryCount,
      events: {
        create: {
          event: 'marked_for_retry',
          details: { error, retryCount: newRetryCount },
        },
      },
    },
  });
}

/**
 * Log a delivery attempt for operational monitoring
 */
export async function logDelivery(
  fbPostId: string,
  success: boolean,
  discordMsgId?: string,
  errorMessage?: string,
  latencyMs?: number
): Promise<void> {
  await prisma.deliveryLog.create({
    data: {
      fbPostId,
      success,
      discordMsgId,
      errorMessage,
      latencyMs,
    },
  });
}

/**
 * Get posts that need processing (for monitoring/debugging)
 */
export async function getPendingPosts(limit = 100): Promise<Post[]> {
  return prisma.post.findMany({
    where: {
      status: {
        in: [PostStatus.received, PostStatus.fetching, PostStatus.eligible, PostStatus.sending],
      },
    },
    orderBy: { receivedAt: 'asc' },
    take: limit,
  });
}

/**
 * Clean up old records (for maintenance)
 */
export async function cleanupOldRecords(daysOld: number): Promise<number> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - daysOld);

  const result = await prisma.post.deleteMany({
    where: {
      status: { in: [PostStatus.delivered, PostStatus.ignored] },
      receivedAt: { lt: cutoff },
    },
  });

  log.info({ deleted: result.count, daysOld }, 'Cleaned up old records');
  return result.count;
}
