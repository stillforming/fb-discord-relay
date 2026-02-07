import { config } from '../config.js';

/**
 * Check if a message contains the trigger tag (case-insensitive)
 * Uses word boundary to avoid matching #discord-like when looking for #discord
 */
export function hasTag(message: string | null | undefined): boolean {
  if (!message) {
    return false;
  }
  // Escape special regex chars and add word boundary at end
  const escaped = config.TRIGGER_TAG.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(escaped + '(?![\\w-])', 'i');
  return pattern.test(message);
}

/**
 * Remove the trigger tag from a message
 * Handles multiple occurrences and cleans up extra whitespace
 */
export function stripTag(message: string): string {
  const tagPattern = new RegExp(
    // Escape special regex chars in the tag
    config.TRIGGER_TAG.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
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
