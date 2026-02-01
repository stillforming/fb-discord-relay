import { config } from '../../config.js';
import type { Logger } from '../../logger.js';
import { fetchPost } from '../../services/facebook.js';
import { sendToDiscord } from '../../services/discord.js';
import {
  transitionPost,
  markForRetry,
  logDelivery,
  PostStatus,
  prisma,
} from '../../services/post-state.js';
import { hasTag } from '../../utils/tag-parser.js';

/**
 * Process a Facebook post through the delivery pipeline
 * 
 * State machine:
 *   received → fetching → eligible → sending → delivered
 *                      ↘ ignored (no tag)
 *                               ↘ failed / needs_review
 */
export async function processPost(fbPostId: string, log: Logger): Promise<void> {
  const startTime = Date.now();

  // Get current post state
  const post = await prisma.post.findUnique({ where: { fbPostId } });
  if (!post) {
    log.warn({ fbPostId }, 'Post not found in database');
    return;
  }

  // Skip if already in terminal state
  if ([PostStatus.delivered, PostStatus.ignored].includes(post.status)) {
    log.debug({ fbPostId, status: post.status }, 'Post already in terminal state');
    return;
  }

  // Check kill switch
  if (!config.ALERTS_ENABLED) {
    log.info({ fbPostId }, 'Alerts disabled, skipping');
    return;
  }

  // === FETCH ===
  log.debug({ fbPostId }, 'Fetching post from Facebook');
  await transitionPost(fbPostId, PostStatus.fetching);

  const fetchResult = await fetchPost(fbPostId);

  if (!fetchResult.success) {
    log.warn({ fbPostId, error: fetchResult.error }, 'Failed to fetch post');

    if (fetchResult.retryable) {
      await markForRetry(fbPostId, fetchResult.error || 'Fetch failed');
      throw new Error(`Retryable fetch error: ${fetchResult.error}`);
    }

    await transitionPost(fbPostId, PostStatus.failed, {
      lastError: fetchResult.error,
    });
    return;
  }

  const fbPost = fetchResult.post!;

  // Update post with fetched data
  await prisma.post.update({
    where: { fbPostId },
    data: {
      authorId: fbPost.from?.id,
      authorName: fbPost.from?.name,
      message: fbPost.message,
      permalink: fbPost.permalink_url,
      createdAt: fbPost.created_time ? new Date(fbPost.created_time) : undefined,
    },
  });

  // === CHECK TAG ===
  if (!hasTag(fbPost.message)) {
    log.info({ fbPostId }, 'No trigger tag found, ignoring');
    await transitionPost(fbPostId, PostStatus.ignored, undefined, {
      reason: 'No trigger tag',
    });
    return;
  }

  log.info({ fbPostId }, 'Trigger tag found, post is eligible');
  await transitionPost(fbPostId, PostStatus.eligible);

  // === SEND ===
  await transitionPost(fbPostId, PostStatus.sending);

  const sendResult = await sendToDiscord(fbPost);
  const latencyMs = Date.now() - startTime;

  // Log delivery attempt
  await logDelivery(
    fbPostId,
    sendResult.success,
    sendResult.messageId,
    sendResult.error,
    latencyMs
  );

  if (sendResult.success) {
    await transitionPost(
      fbPostId,
      PostStatus.delivered,
      {
        discordMsgId: sendResult.messageId,
        deliveredAt: new Date(),
      },
      { messageId: sendResult.messageId, latencyMs }
    );
    log.info({ fbPostId, messageId: sendResult.messageId, latencyMs }, '✅ Post delivered');
    return;
  }

  // Handle send failure
  if (sendResult.ambiguous) {
    // This is the dangerous case - we don't know if Discord received it
    // Mark for manual review to avoid duplicate alerts
    await transitionPost(
      fbPostId,
      PostStatus.needs_review,
      { lastError: sendResult.error },
      { reason: 'Delivery status unknown', error: sendResult.error }
    );
    log.error({ fbPostId }, '⚠️ Delivery status unknown - manual review required');
    return;
  }

  if (sendResult.retryable) {
    await markForRetry(fbPostId, sendResult.error || 'Send failed');

    // If rate limited, throw with delay hint
    if (sendResult.retryAfterMs) {
      log.warn({ fbPostId, retryAfterMs: sendResult.retryAfterMs }, 'Rate limited, will retry');
    }

    throw new Error(`Retryable send error: ${sendResult.error}`);
  }

  // Non-retryable failure
  await transitionPost(
    fbPostId,
    PostStatus.failed,
    { lastError: sendResult.error },
    { error: sendResult.error }
  );
  log.error({ fbPostId, error: sendResult.error }, '❌ Post delivery failed');
}
