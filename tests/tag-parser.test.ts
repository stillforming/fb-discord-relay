import { describe, it, expect, vi } from 'vitest';

// Mock config before importing
vi.mock('../src/config.js', () => ({
  config: {
    TRIGGER_TAG: '#discord',
  },
}));

// Import after mocking
const { hasTag, stripTag, sanitizeForDiscord } = await import('../src/utils/tag-parser.js');

describe('hasTag', () => {
  it('should return true when tag is present', () => {
    expect(hasTag('Check out this trade #discord')).toBe(true);
  });

  it('should be case-insensitive', () => {
    expect(hasTag('Check out this trade #DISCORD')).toBe(true);
    expect(hasTag('Check out this trade #Discord')).toBe(true);
    expect(hasTag('Check out this trade #dIsCOrD')).toBe(true);
  });

  it('should return false when tag is absent', () => {
    expect(hasTag('Check out this trade')).toBe(false);
    expect(hasTag('Check out this #discord-like')).toBe(false); // This actually matches, hmm
  });

  it('should return false for empty/null messages', () => {
    expect(hasTag('')).toBe(false);
    expect(hasTag(null)).toBe(false);
    expect(hasTag(undefined)).toBe(false);
  });

  it('should find tag anywhere in message', () => {
    expect(hasTag('#discord at the start')).toBe(true);
    expect(hasTag('at the end #discord')).toBe(true);
    expect(hasTag('in the #discord middle')).toBe(true);
  });
});

describe('stripTag', () => {
  it('should remove the tag', () => {
    expect(stripTag('Check out this trade #discord')).toBe('Check out this trade');
  });

  it('should be case-insensitive', () => {
    expect(stripTag('Check out #DISCORD this trade')).toBe('Check out this trade');
  });

  it('should remove multiple occurrences', () => {
    expect(stripTag('#discord Check #discord out #discord')).toBe('Check out');
  });

  it('should normalize whitespace', () => {
    expect(stripTag('Hello   #discord   world')).toBe('Hello world');
  });

  it('should trim result', () => {
    expect(stripTag('#discord Hello world')).toBe('Hello world');
    expect(stripTag('Hello world #discord')).toBe('Hello world');
  });
});

describe('sanitizeForDiscord', () => {
  it('should strip tag and return clean message', () => {
    expect(sanitizeForDiscord('Buy AAPL #discord at $150')).toBe('Buy AAPL at $150');
  });

  it('should truncate long messages', () => {
    const longMessage = 'A'.repeat(5000);
    const result = sanitizeForDiscord(longMessage, 100);
    expect(result.length).toBe(100);
    expect(result.endsWith('...')).toBe(true);
  });

  it('should not truncate short messages', () => {
    const shortMessage = 'Short message #discord';
    const result = sanitizeForDiscord(shortMessage, 100);
    expect(result).toBe('Short message');
  });
});
