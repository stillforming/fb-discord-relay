import { config } from '../config.js';
import { logger } from '../logger.js';
import { sanitizeForDiscord } from '../utils/tag-parser.js';
import type { FacebookPost } from './facebook.js';

const log = logger.child({ service: 'discord' });

export interface DiscordEmbed {
  title?: string;
  description?: string;
  url?: string;
  color?: number;
  timestamp?: string;
  footer?: {
    text: string;
  };
  image?: {
    url: string;
  };
}

export interface DiscordWebhookPayload {
  content?: string;
  embeds?: DiscordEmbed[];
  allowed_mentions?: {
    parse: string[];
    roles?: string[];
  };
}

export interface SendResult {
  success: boolean;
  messageId?: string;
  error?: string;
  retryable?: boolean;
  retryAfterMs?: number;
  ambiguous?: boolean; // True if we sent but got timeout (delivery unknown)
}

/**
 * Build a Discord embed from a Facebook post
 */
export function buildEmbed(post: FacebookPost): DiscordEmbed {
  const message = post.message ? sanitizeForDiscord(post.message) : 'New post (no text content)';

  const embed: DiscordEmbed = {
    title: '📈 TRADE ALERT',
    description: message,
    color: 0x1877f2, // Facebook blue
    footer: {
      text: `fb_post_id: ${post.id}`,
    },
  };

  // Add permalink if available
  if (post.permalink_url) {
    embed.url = post.permalink_url;
  }

  // Add timestamp if available
  if (post.created_time) {
    embed.timestamp = post.created_time;
  }

  // Add first image attachment if available
  const imageAttachment = post.attachments?.data?.find(
    (a) => a.media_type === 'photo' || a.media?.image?.src
  );
  if (imageAttachment?.media?.image?.src) {
    embed.image = { url: imageAttachment.media.image.src };
  } else if (imageAttachment?.url) {
    embed.image = { url: imageAttachment.url };
  }

  return embed;
}

/**
 * Send a Facebook post to Discord via webhook
 */
export async function sendToDiscord(post: FacebookPost): Promise<SendResult> {
  const embed = buildEmbed(post);

  // Build content with optional role mention and disclaimer
  const contentParts: string[] = [];
  
  // Add role mention if configured
  if (config.DISCORD_MENTION_ROLE_ID) {
    contentParts.push(`<@&${config.DISCORD_MENTION_ROLE_ID}>`);
  }
  
  // Add disclaimer
  if (config.DISCORD_DISCLAIMER) {
    contentParts.push(`*${config.DISCORD_DISCLAIMER}*`);
  }

  const payload: DiscordWebhookPayload = {
    embeds: [embed],
    allowed_mentions: {
      parse: [], // Don't parse @everyone/@here
      roles: config.DISCORD_MENTION_ROLE_ID ? [config.DISCORD_MENTION_ROLE_ID] : [],
    },
  };

  if (contentParts.length > 0) {
    payload.content = contentParts.join('\n');
  }

  // Build URL with wait parameter for message ID
  const url = new URL(config.DISCORD_WEBHOOK_URL);
  if (config.DISCORD_WEBHOOK_WAIT) {
    url.searchParams.set('wait', 'true');
  }

  log.debug({ postId: post.id }, 'Sending to Discord webhook');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000); // 30s timeout

  try {
    const response = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    // Handle rate limits
    if (response.status === 429) {
      const retryAfter = response.headers.get('retry-after');
      const retryAfterMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 5000;
      log.warn({ postId: post.id, retryAfterMs }, 'Discord rate limited');
      return {
        success: false,
        error: 'Rate limited',
        retryable: true,
        retryAfterMs,
      };
    }

    if (!response.ok) {
      const error = await response.text();
      log.error({ postId: post.id, status: response.status, error }, 'Discord webhook error');
      return {
        success: false,
        error: `HTTP ${response.status}: ${error}`,
        retryable: response.status >= 500,
      };
    }

    // Get message ID from response (only if wait=true)
    let messageId: string | undefined;
    if (config.DISCORD_WEBHOOK_WAIT) {
      try {
        const data = await response.json() as { id?: string };
        messageId = data.id;
      } catch {
        // Response might be empty
      }
    }

    log.info({ postId: post.id, messageId }, 'Successfully sent to Discord');

    return {
      success: true,
      messageId,
    };
  } catch (err) {
    clearTimeout(timeout);

    // Check if this was a timeout after the request was sent
    // This is the ambiguous case - we don't know if Discord received it
    if (err instanceof Error && err.name === 'AbortError') {
      log.error({ postId: post.id }, 'Discord request timed out - delivery status unknown');
      return {
        success: false,
        error: 'Request timed out - delivery status unknown',
        retryable: false,
        ambiguous: true,
      };
    }

    log.error({ postId: post.id, error: err }, 'Network error sending to Discord');
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Unknown network error',
      retryable: true,
    };
  }
}

/**
 * Test the Discord webhook is valid
 */
export async function testWebhook(): Promise<boolean> {
  try {
    // Just do a GET to verify the webhook exists
    const response = await fetch(config.DISCORD_WEBHOOK_URL);

    if (!response.ok) {
      log.error({ status: response.status }, 'Discord webhook verification failed');
      return false;
    }

    const data = await response.json() as { name?: string; channel_id?: string };
    log.info({ name: data.name, channelId: data.channel_id }, 'Discord webhook verified');
    return true;
  } catch (err) {
    log.error({ error: err }, 'Failed to verify Discord webhook');
    return false;
  }
}
