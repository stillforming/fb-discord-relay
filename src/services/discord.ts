import { config } from '../config.js';
import { logger } from '../logger.js';
import { sanitizeForDiscord, findRoutedChannel } from '../utils/tag-parser.js';
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
  ambiguous?: boolean;
  channel?: string;
}

/**
 * Build a Discord embed from a Facebook post
 * Now only contains the image and link — text moved to content for better notifications
 */
export function buildEmbed(post: FacebookPost, title = '📈 TRADE ALERT'): DiscordEmbed {
  const embed: DiscordEmbed = {
    title,
    color: 0x1877f2, // Facebook blue
  };

  if (post.permalink_url) {
    embed.url = post.permalink_url;
    embed.footer = { text: '🔗 Click title to view on Facebook' };
  }

  if (post.created_time) {
    embed.timestamp = post.created_time;
  }

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
 * Determine which webhook URL to use based on post content
 */
export function resolveWebhook(post: FacebookPost): { url: string; label: string; title: string } {
  const message = post.message || '';

  const routed = findRoutedChannel(message);
  if (routed) {
    let title = '📈 TRADE ALERT';
    if (routed.tag === '#stockmarketnews') {
      title = '📰 STOCK MARKET NEWS';
    } else if (routed.tag === '#stockstowatch') {
      title = '👀 STOCKS TO WATCH';
    }

    log.info({ postId: post.id, routedTag: routed.tag }, 'Routing to channel-specific webhook');
    return { url: routed.webhookUrl, label: routed.tag, title };
  }

  return { url: config.DISCORD_WEBHOOK_URL, label: 'default', title: '📈 TRADE ALERT' };
}

/**
 * Send a Facebook post to Discord via webhook
 *
 * Message layout (optimized for push notification previews):
 *   Content: Post text first (shows in notification preview)
 *            Disclaimer + role mention at bottom
 *   Embed:   Title (clickable link), image, timestamp
 */
export async function sendToDiscord(post: FacebookPost): Promise<SendResult> {
  const { url: webhookUrl, label: channelLabel, title } = resolveWebhook(post);
  const embed = buildEmbed(post, title);

  const contentParts: string[] = [];

  // Post text at the top — this is what shows in push notifications
  const postText = post.message ? sanitizeForDiscord(post.message) : '';
  if (postText) {
    contentParts.push(postText);
  }

  // Blank line separator
  if (postText) {
    contentParts.push('');
  }

  // Disclaimer
  if (config.DISCORD_DISCLAIMER) {
    contentParts.push(`*${config.DISCORD_DISCLAIMER}*`);
  }

  // Role mention at the BOTTOM (still triggers notification, but doesn't eat preview space)
  if (config.DISCORD_MENTION_ROLE_ID) {
    contentParts.push(`<@&${config.DISCORD_MENTION_ROLE_ID}>`);
  }

  const payload: DiscordWebhookPayload = {
    embeds: [embed],
    allowed_mentions: {
      parse: [],
      roles: config.DISCORD_MENTION_ROLE_ID ? [config.DISCORD_MENTION_ROLE_ID] : [],
    },
  };

  if (contentParts.length > 0) {
    payload.content = contentParts.join('\n');
  }

  const url = new URL(webhookUrl);
  if (config.DISCORD_WEBHOOK_WAIT) {
    url.searchParams.set('wait', 'true');
  }

  log.debug({ postId: post.id, channel: channelLabel }, 'Sending to Discord webhook');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    const response = await fetch(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (response.status === 429) {
      const retryAfter = response.headers.get('retry-after');
      const retryAfterMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 5000;
      log.warn({ postId: post.id, retryAfterMs, channel: channelLabel }, 'Discord rate limited');
      return { success: false, error: 'Rate limited', retryable: true, retryAfterMs, channel: channelLabel };
    }

    if (!response.ok) {
      const error = await response.text();
      log.error({ postId: post.id, status: response.status, error, channel: channelLabel }, 'Discord webhook error');
      return { success: false, error: `HTTP ${response.status}: ${error}`, retryable: response.status >= 500, channel: channelLabel };
    }

    let messageId: string | undefined;
    if (config.DISCORD_WEBHOOK_WAIT) {
      try {
        const data = await response.json() as { id?: string };
        messageId = data.id;
      } catch { /* empty */ }
    }

    log.info({ postId: post.id, messageId, channel: channelLabel }, 'Successfully sent to Discord');
    return { success: true, messageId, channel: channelLabel };
  } catch (err) {
    clearTimeout(timeout);

    if (err instanceof Error && err.name === 'AbortError') {
      log.error({ postId: post.id, channel: channelLabel }, 'Discord request timed out - delivery status unknown');
      return { success: false, error: 'Request timed out - delivery status unknown', retryable: false, ambiguous: true, channel: channelLabel };
    }

    log.error({ postId: post.id, error: err, channel: channelLabel }, 'Network error sending to Discord');
    return { success: false, error: err instanceof Error ? err.message : 'Unknown network error', retryable: true, channel: channelLabel };
  }
}

/**
 * Test the Discord webhook is valid
 */
export async function testWebhook(): Promise<boolean> {
  try {
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
