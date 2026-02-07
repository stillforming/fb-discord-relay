import { config, getChannelRoutes, getChannelPriority } from '../config.js';

/**
 * Check if a message contains the trigger tag (case-insensitive)
 * Uses word boundary to avoid matching #discord-like when looking for #discord
 */
export function hasTag(message: string | null | undefined): boolean {
  if (!message) {
    return false;
  }
  // Escape special regex chars and add word boundary at end
  const escaped = config.TRIGGER_TAG.replace(/[.*+?${}()|[\]\\]/g, '\\\$&');
  const pattern = new RegExp(escaped + '(?![\\w-])', 'i');
  return pattern.test(message);
}

/**
 * Check if a message contains ANY of the routable hashtags or the trigger tag
 */
export function hasAnyTrackedTag(message: string | null | undefined): boolean {
  if (!message) {
    return false;
  }
  
  // Check trigger tag first
  if (hasTag(message)) {
    return true;
  }
  
  // Check channel route tags
  const routes = getChannelRoutes();
  const msgLower = message.toLowerCase();
  
  for (const tag of routes.keys()) {
    // Simple case-insensitive substring match for hashtags
    if (msgLower.includes(tag)) {
      return true;
    }
  }
  
  return false;
}

/**
 * Find the highest priority matching hashtag in a message
 * Returns the hashtag (lowercase) and its webhook URL, or null if no match
 */
export function findRoutedChannel(message: string | null | undefined): { tag: string; webhookUrl: string } | null {
  if (!message) {
    return null;
  }
  
  const routes = getChannelRoutes();
  const priority = getChannelPriority();
  const msgLower = message.toLowerCase();
  
  // Check in priority order
  for (const tag of priority) {
    if (msgLower.includes(tag) && routes.has(tag)) {
      return { tag, webhookUrl: routes.get(tag)! };
    }
  }
  
  return null;
}

/**
 * Remove the trigger tag from a message
 * Handles multiple occurrences and cleans up extra whitespace
 */
export function stripTag(message: string): string {
  const tagPattern = new RegExp(
    // Escape special regex chars in the tag
    config.TRIGGER_TAG.replace(/[.*+?${}()|[\]\\]/g, '\\\$&'),
    'gi'
  );

  return message
    .replace(tagPattern, '')
    .replace(/\s+/g, ' ') // Normalize multiple spaces
    .trim();
}

/**
 * Strip all hashtags from a message
 * Hashtags are Facebook-native and do not serve a purpose on Discord
 */
export function stripAllHashtags(message: string): string {
  return message
    .replace(/#\w+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Sanitize message for Discord
 * - Strip trigger tag
 * - Strip all hashtags (they do not serve a purpose on Discord)
 * - Truncate to safe length
 */
export function sanitizeForDiscord(message: string, maxLength = 4000): string {
  let cleaned = stripTag(message);

  // Strip all hashtags - they are Facebook-native and just noise on Discord
  cleaned = stripAllHashtags(cleaned);

  // Truncate if too long (leave room for ... indicator)
  if (cleaned.length > maxLength) {
    cleaned = cleaned.slice(0, maxLength - 3) + '...';
  }

  return cleaned;
}
