import PgBoss from 'pg-boss';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { prisma } from '../services/post-state.js';
import { processPost } from './handlers/process-post.js';
import { verifyPageAccess } from '../services/facebook.js';
import { testWebhook } from '../services/discord.js';

const log = logger.child({ component: 'worker' });

// Queue name (must match ingress)
const PROCESS_POST_QUEUE = 'process-post';

interface ProcessPostJob {
  fbPostId: string;
  correlationId: string;
}

async function main() {
  log.info('Starting worker...');

  // Verify external dependencies on startup
  log.info('Verifying Facebook page access...');
  const fbOk = await verifyPageAccess();
  if (!fbOk) {
    log.error('Failed to verify Facebook page access. Check META_PAGE_ACCESS_TOKEN.');
    process.exit(1);
  }

  log.info('Verifying Discord webhook...');
  const discordOk = await testWebhook();
  if (!discordOk) {
    log.error('Failed to verify Discord webhook. Check DISCORD_WEBHOOK_URL.');
    process.exit(1);
  }

  // Create pg-boss instance
  const boss = new PgBoss({
    connectionString: config.DATABASE_URL,
    deleteAfterDays: 7,
    retryLimit: 5,
    retryDelay: 5,
    retryBackoff: true,
  });

  // Handle pg-boss errors
  boss.on('error', (err) => {
    log.error({ error: err }, 'pg-boss error');
  });

  boss.on('monitor-states', (states) => {
    log.debug({ states }, 'Queue states');
  });

  // Start pg-boss
  await boss.start();
  log.info('pg-boss started');

  // Register job handler
  await boss.work<ProcessPostJob>(
    PROCESS_POST_QUEUE,
    { teamSize: 5, teamConcurrency: 2 },
    async (job) => {
      const { fbPostId, correlationId } = job.data;
      const jobLog = logger.child({ correlationId, jobId: job.id, fbPostId });

      jobLog.info('Processing post job');

      try {
        await processPost(fbPostId, jobLog);
        jobLog.info('Post processed successfully');
      } catch (err) {
        jobLog.error({ error: err }, 'Failed to process post');
        throw err; // Let pg-boss handle retry
      }
    }
  );

  log.info({ queue: PROCESS_POST_QUEUE }, '📬 Worker listening for jobs');

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    log.info({ signal }, 'Shutting down worker...');
    await boss.stop();
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  log.fatal({ error: err }, 'Failed to start worker');
  process.exit(1);
});
