import { config as dotenvConfig } from 'dotenv';
import { z } from 'zod';

// Load .env file
dotenvConfig();

const envSchema = z.object({
  // Server
  PORT: z.coerce.number().default(3000),
  PUBLIC_BASE_URL: z.string().url().optional(),

  // Meta / Facebook
  META_VERIFY_TOKEN: z.string().min(1),
  META_APP_SECRET: z.string().min(1),
  META_GRAPH_VERSION: z.string().default('v24.0'),
  META_PAGE_ID: z.string().min(1),
  META_PAGE_ACCESS_TOKEN: z.string().min(1),

  // Discord - Default webhook (for #nofomo / fallback)
  DISCORD_WEBHOOK_URL: z.string().url(),
  DISCORD_WEBHOOK_WAIT: z
    .string()
    .transform((v) => v === 'true')
    .default('true'),
  DISCORD_DISCLAIMER: z.string().default('Not financial advice. Do your own research.'),
  DISCORD_MENTION_ROLE_ID: z.string().optional(),

  // Application
  ALERTS_ENABLED: z
    .string()
    .transform((v) => v === 'true')
    .default('true'),
  TRIGGER_TAG: z.string().default('#discord'),
  
  // Post age filter - ignore posts older than this many minutes (0 = disabled)
  MAX_POST_AGE_MINUTES: z.coerce.number().default(30),

  // Channel routing - JSON string mapping hashtags to webhook URLs
  // Format: {#stockmarketnews: https://..., #stockstowatch: https://...}
  // Priority is determined by CHANNEL_PRIORITY order
  CHANNEL_ROUTES: z.string().optional(),
  
  // Priority order for channel routing (comma-separated, case-insensitive)
  // First match wins. Posts without any match use default DISCORD_WEBHOOK_URL
  CHANNEL_PRIORITY: z.string().default('#stockmarketnews,#stockstowatch'),

  // Database
  DATABASE_URL: z.string().min(1),

  // Logging
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
});

function loadConfig() {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    console.error('❌ Invalid environment configuration:');
    for (const issue of result.error.issues) {
      console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
    }
    process.exit(1);
  }

  return result.data;
}

export const config = loadConfig();

// Parse channel routes into a Map for easy lookup
export function getChannelRoutes(): Map<string, string> {
  const routes = new Map<string, string>();
  
  if (!config.CHANNEL_ROUTES) {
    return routes;
  }
  
  try {
    const parsed = JSON.parse(config.CHANNEL_ROUTES) as Record<string, string>;
    for (const [tag, url] of Object.entries(parsed)) {
      // Normalize to lowercase for case-insensitive matching
      routes.set(tag.toLowerCase(), url);
    }
  } catch (err) {
    console.error('Failed to parse CHANNEL_ROUTES:', err);
  }
  
  return routes;
}

// Get priority order as lowercase array
export function getChannelPriority(): string[] {
  return config.CHANNEL_PRIORITY
    .split(',')
    .map(tag => tag.trim().toLowerCase())
    .filter(tag => tag.length > 0);
}

export type Config = typeof config;
