import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHmac } from 'crypto';

// Mock config before importing
vi.mock('../src/config.js', () => ({
  config: {
    META_APP_SECRET: 'test-secret-12345',
  },
}));

// Import after mocking
const { verifySignature } = await import('../src/utils/signature.js');

describe('verifySignature', () => {
  const secret = 'test-secret-12345';

  function createValidSignature(body: string | Buffer): string {
    const hmac = createHmac('sha256', secret);
    hmac.update(body);
    return 'sha256=' + hmac.digest('hex');
  }

  it('should return true for valid signature', () => {
    const body = Buffer.from('{"test": "data"}');
    const signature = createValidSignature(body);

    expect(verifySignature(body, signature)).toBe(true);
  });

  it('should return false for invalid signature', () => {
    const body = Buffer.from('{"test": "data"}');
    const signature = 'sha256=invalid0000000000000000000000000000000000000000000000000000000000';

    expect(verifySignature(body, signature)).toBe(false);
  });

  it('should return false for missing signature', () => {
    const body = Buffer.from('{"test": "data"}');

    expect(verifySignature(body, undefined)).toBe(false);
  });

  it('should return false for wrong prefix', () => {
    const body = Buffer.from('{"test": "data"}');
    const hmac = createHmac('sha256', secret);
    hmac.update(body);
    const signature = 'sha1=' + hmac.digest('hex'); // Wrong prefix

    expect(verifySignature(body, signature)).toBe(false);
  });

  it('should return false for tampered body', () => {
    const originalBody = Buffer.from('{"test": "data"}');
    const tamperedBody = Buffer.from('{"test": "hacked"}');
    const signature = createValidSignature(originalBody);

    expect(verifySignature(tamperedBody, signature)).toBe(false);
  });

  it('should handle empty body', () => {
    const body = Buffer.from('');
    const signature = createValidSignature(body);

    expect(verifySignature(body, signature)).toBe(true);
  });

  it('should handle malformed hex signature', () => {
    const body = Buffer.from('{"test": "data"}');
    const signature = 'sha256=not-valid-hex';

    expect(verifySignature(body, signature)).toBe(false);
  });
});
