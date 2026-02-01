import pino from 'pino';
import { config } from './config.js';

export const logger = pino({
  level: config.LOG_LEVEL,
  transport:
    process.env.NODE_ENV !== 'production'
      ? {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:standard',
            ignore: 'pid,hostname',
          },
        }
      : undefined,
  base: {
    service: 'fb-discord-relay',
  },
});

/**
 * Create a child logger with correlation ID for request tracing
 */
export function createRequestLogger(correlationId: string) {
  return logger.child({ correlationId });
}

export type Logger = typeof logger;
