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

  // Discord
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

export type Config = typeof config;
