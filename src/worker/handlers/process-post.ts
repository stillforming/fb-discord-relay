import { config } from '../../config.js';
import type { Logger } from '../../logger.js';
import { fetchPost, type FacebookPost } from '../../services/facebook.js';
import { sendToDiscord } from '../../services/discord.js';
import {
  transitionPost,
  markForRetry,
  logDelivery,
  PostStatus,
  prisma,
} from '../../services/post-state.js';
import { hasAnyTrackedTag } from '../../utils/tag-parser.js';

interface WebhookData {
  message?: string;
  from?: { id: string; name: string };
  createdTime?: number;
}

/**
 * Check if a post is too old based on its created_time
 * Returns true if the post should be skipped
 */
function isPostTooOld(createdTime: string | undefined, log: Logger): boolean {
  // If age filtering is disabled (0), allow all posts
  if (config.MAX_POST_AGE_MINUTES === 0) {
    return false;
  }

  // If no created_time, we can't determine age - reject to be safe
  if (!createdTime) {
    log.warn('No created_time available, rejecting post to be safe');
    return true;
  }

  const postDate = new Date(createdTime);
  const postAgeMs = Date.now() - postDate.getTime();
  const maxAgeMs = config.MAX_POST_AGE_MINUTES * 60 * 1000;
  
  if (postAgeMs > maxAgeMs) {
    const ageMinutes = Math.round(postAgeMs / 60000);
    log.info({ ageMinutes, maxMinutes: config.MAX_POST_AGE_MINUTES }, 'Post too old, ignoring');
    return true;
  }
  
  return false;
}

/**
 * Process a Facebook post through the delivery pipeline
 * 
 * State machine:
 *   received → fetching → eligible → sending → delivered
 *                      ↘ ignored (no tag or too old)
 *                               ↘ failed / needs_review
 */
export async function processPost(fbPostId: string, log: Logger, webhookData?: WebhookData): Promise<void> {
  const startTime = Date.now();

  // Get current post state
  const post = await prisma.post.findUnique({ where: { fbPostId } });
  if (!post) {
    log.warn({ fbPostId }, 'Post not found in database');
    return;
  }

  // Skip if already in terminal state
  if (post.status === PostStatus.delivered || post.status === PostStatus.ignored) {
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

  let fbPost: FacebookPost;

  if (!fetchResult.success) {
    log.warn({ fbPostId, error: fetchResult.error }, 'Failed to fetch post from Graph API');

    // If we have webhook data, use it as fallback
    if (webhookData?.message) {
      log.info({ fbPostId }, 'Using webhook data as fallback');
      fbPost = {
        id: fbPostId,
        message: webhookData.message,
        from: webhookData.from,
        created_time: webhookData.createdTime 
          ? new Date(webhookData.createdTime * 1000).toISOString() 
          : undefined,
      };
    } else {
      if (fetchResult.retryable) {
        await markForRetry(fbPostId, fetchResult.error || 'Fetch failed');
        throw new Error(`Retryable fetch error: ${fetchResult.error}`);
      }

      await transitionPost(fbPostId, PostStatus.failed, {
        lastError: fetchResult.error,
      });
      return;
    }
  } else {
    fbPost = fetchResult.post!;
  }

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

  // === CHECK AGE (after fetch, using accurate created_time) ===
  if (isPostTooOld(fbPost.created_time, log)) {
    log.info({ fbPostId }, 'Post too old after fetch verification, ignoring');
    await transitionPost(fbPostId, PostStatus.ignored, undefined, {
      reason: 'Post too old',
    });
    return;
  }

  // === CHECK TAG ===
  // Now checks for ANY tracked tag (trigger tag OR routed channel tags)
  if (!hasAnyTrackedTag(fbPost.message)) {
    log.info({ fbPostId }, 'No tracked hashtag found, ignoring');
    await transitionPost(fbPostId, PostStatus.ignored, undefined, {
      reason: 'No tracked hashtag',
    });
    return;
  }

  log.info({ fbPostId }, 'Tracked hashtag found, post is eligible');
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
      { messageId: sendResult.messageId, latencyMs, channel: sendResult.channel }
    );
    log.info({ fbPostId, messageId: sendResult.messageId, latencyMs, channel: sendResult.channel }, '✅ Post delivered');
    return;
  }

  // Handle send failure
  if (sendResult.ambiguous) {
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
