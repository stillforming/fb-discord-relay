import { createHmac, timingSafeEqual } from 'crypto';
import { config } from '../config.js';

/**
 * Verify Facebook webhook signature using HMAC SHA-256
 * Uses timing-safe comparison to prevent timing attacks
 */
export function verifySignature(rawBody: Buffer, signature: string | undefined): boolean {
  if (!signature) {
    return false;
  }

  // Signature format: "sha256=<hex>"
  const expectedPrefix = 'sha256=';
  if (!signature.startsWith(expectedPrefix)) {
    return false;
  }

  const providedHash = signature.slice(expectedPrefix.length);

  // Compute expected hash
  const hmac = createHmac('sha256', config.META_APP_SECRET);
  hmac.update(rawBody);
  const expectedHash = hmac.digest('hex');

  // Use timing-safe comparison
  try {
    const providedBuffer = Buffer.from(providedHash, 'hex');
    const expectedBuffer = Buffer.from(expectedHash, 'hex');

    if (providedBuffer.length !== expectedBuffer.length) {
      return false;
    }

    return timingSafeEqual(providedBuffer, expectedBuffer);
  } catch {
    return false;
  }
}

/**
 * Generate appsecret_proof for Graph API calls
 * This proves the request is from an app that knows the secret
 */
export function generateAppSecretProof(accessToken: string): string {
  const hmac = createHmac('sha256', config.META_APP_SECRET);
  hmac.update(accessToken);
  return hmac.digest('hex');
}
