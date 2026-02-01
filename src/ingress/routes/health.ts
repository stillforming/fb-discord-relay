import type { FastifyInstance } from 'fastify';
import { prisma } from '../../services/post-state.js';

export async function healthRoutes(app: FastifyInstance) {
  /**
   * Basic health check
   */
  app.get('/healthz', async (request, reply) => {
    try {
      // Check database connection
      await prisma.$queryRaw`SELECT 1`;
      
      return {
        status: 'healthy',
        timestamp: new Date().toISOString(),
      };
    } catch (err) {
      reply.status(503);
      return {
        status: 'unhealthy',
        error: 'Database connection failed',
        timestamp: new Date().toISOString(),
      };
    }
  });

  /**
   * Detailed readiness check
   */
  app.get('/readyz', async (request, reply) => {
    const checks: Record<string, boolean> = {};
    let healthy = true;

    // Database check
    try {
      await prisma.$queryRaw`SELECT 1`;
      checks.database = true;
    } catch {
      checks.database = false;
      healthy = false;
    }

    if (!healthy) {
      reply.status(503);
    }

    return {
      status: healthy ? 'ready' : 'not_ready',
      checks,
      timestamp: new Date().toISOString(),
    };
  });
}
