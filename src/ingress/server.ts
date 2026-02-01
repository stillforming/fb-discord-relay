import Fastify from 'fastify';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { healthRoutes } from './routes/health.js';
import { metaWebhookRoutes } from './routes/meta-webhook.js';
import { prisma } from '../services/post-state.js';
import PgBoss from 'pg-boss';

const log = logger.child({ component: 'ingress' });

// Create pg-boss instance (shared with routes)
export const boss = new PgBoss({
  connectionString: config.DATABASE_URL,
  // Use pg-boss archive instead of delete for audit trail
  deleteAfterDays: 7,
  retryLimit: 5,
  retryDelay: 5, // 5 seconds
  retryBackoff: true,
});

async function main() {
  // Start pg-boss
  await boss.start();
  log.info('pg-boss started');

  // Create Fastify server
  const app = Fastify({
    logger: false, // We use pino directly
    // Enable raw body for signature verification
    bodyLimit: 1048576, // 1MB
  });

  // Add raw body hook for signature verification
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (req, body, done) => {
      // Store raw body for signature verification
      (req as any).rawBody = body;
      try {
        const json = JSON.parse(body.toString());
        done(null, json);
      } catch (err) {
        done(err as Error, undefined);
      }
    }
  );

  // Register routes
  await app.register(healthRoutes);
  await app.register(metaWebhookRoutes, { prefix: '/meta' });

  // Error handler
  app.setErrorHandler((error, request, reply) => {
    log.error({ error, url: request.url, method: request.method }, 'Unhandled error');
    reply.status(500).send({ error: 'Internal server error' });
  });

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    log.info({ signal }, 'Shutting down...');
    await app.close();
    await boss.stop();
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Start server
  const address = await app.listen({ port: config.PORT, host: '0.0.0.0' });
  log.info({ address, port: config.PORT }, '🚀 Ingress server started');
}

main().catch((err) => {
  log.fatal({ error: err }, 'Failed to start server');
  process.exit(1);
});
