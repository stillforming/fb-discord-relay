import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'crypto';
import { config } from '../../config.js';
import { createRequestLogger, logger } from '../../logger.js';
import { verifySignature } from '../../utils/signature.js';
import { getOrCreatePost } from '../../services/post-state.js';
import { boss } from '../server.js';

const log = logger.child({ component: 'meta-webhook' });

// Job queue name
export const PROCESS_POST_QUEUE = 'process-post';

interface WebhookVerifyQuery {
  'hub.mode'?: string;
  'hub.verify_token'?: string;
  'hub.challenge'?: string;
}

interface WebhookEntry {
  id: string;
  time: number;
  changes?: Array<{
    field: string;
    value: {
      post_id?: string;
      verb?: string;
      item?: string;
      published?: number;
      message?: string;
      from?: { id: string; name: string };
    };
  }>;
}

interface WebhookPayload {
  object: string;
  entry: WebhookEntry[];
}

export async function metaWebhookRoutes(app: FastifyInstance) {
  /**
   * GET /meta/webhook - Verification handshake
   * Facebook calls this to verify we own the webhook endpoint
   */
  app.get('/webhook', async (
    request: FastifyRequest<{ Querystring: WebhookVerifyQuery }>,
    reply: FastifyReply
  ) => {
    const mode = request.query['hub.mode'];
    const token = request.query['hub.verify_token'];
    const challenge = request.query['hub.challenge'];

    log.info({ mode, hasToken: !!token, hasChallenge: !!challenge }, 'Webhook verification request');

    // Validate mode
    if (mode !== 'subscribe') {
      log.warn({ mode }, 'Invalid hub.mode');
      return reply.status(403).send('Invalid mode');
    }

    // Validate verify token
    if (token !== config.META_VERIFY_TOKEN) {
      log.warn('Invalid verify token');
      return reply.status(403).send('Invalid verify token');
    }

    // Return challenge to complete verification
    if (!challenge) {
      log.warn('Missing challenge');
      return reply.status(400).send('Missing challenge');
    }

    log.info('Webhook verification successful');
    
    // Must return challenge as plain text (not JSON)
    return reply.type('text/plain').send(challenge);
  });

  /**
   * POST /meta/webhook - Receive webhook events
   * Facebook sends events here when page posts are created/updated
   */
  app.post('/webhook', async (
    request: FastifyRequest<{ Body: WebhookPayload }>,
    reply: FastifyReply
  ) => {
    const correlationId = randomUUID();
    const reqLog = createRequestLogger(correlationId);
    const startTime = Date.now();

    // Get raw body for signature verification
    const rawBody = (request as any).rawBody as Buffer;

    // Verify signature
    const signature = request.headers['x-hub-signature-256'] as string | undefined;
    if (!verifySignature(rawBody, signature)) {
      reqLog.warn({ hasSignature: !!signature }, 'Invalid webhook signature');
      return reply.status(403).send('Invalid signature');
    }

    reqLog.debug('Signature verified');

    // Validate payload structure
    const body = request.body;
    if (body.object !== 'page') {
      reqLog.warn({ object: body.object }, 'Unexpected object type');
      // Still return 200 to prevent retries
      return reply.status(200).send('OK');
    }

    // Process entries
    const postIds: string[] = [];

    for (const entry of body.entry) {
      if (!entry.changes) continue;

      for (const change of entry.changes) {
        // We only care about feed changes
        if (change.field !== 'feed') continue;

        const value = change.value;
        
        // Only process new posts (verb === 'add')
        if (value.verb !== 'add') {
          reqLog.debug({ verb: value.verb, item: value.item }, 'Ignoring non-add event');
          continue;
        }

        // Must have post_id
        if (!value.post_id) {
          reqLog.warn({ value }, 'Missing post_id in feed change');
          continue;
        }

        postIds.push(value.post_id);
      }
    }

    // Enqueue jobs for each post (deduplicated by post_id)
    for (const postId of postIds) {
      try {
        // Create post record (idempotent)
        const { created } = await getOrCreatePost(postId);
        
        if (created) {
          // Enqueue processing job
          // Use post_id as singleton key for dedupe
          await boss.send(
            PROCESS_POST_QUEUE,
            { fbPostId: postId, correlationId },
            { singletonKey: postId }
          );
          reqLog.info({ postId }, 'Enqueued post for processing');
        } else {
          reqLog.debug({ postId }, 'Post already exists, skipping enqueue');
        }
      } catch (err) {
        reqLog.error({ postId, error: err }, 'Failed to enqueue post');
        // Continue processing other posts
      }
    }

    const latency = Date.now() - startTime;
    reqLog.info({ postCount: postIds.length, latencyMs: latency }, 'Webhook processed');

    // Always return 200 quickly
    return reply.status(200).send('OK');
  });
}
