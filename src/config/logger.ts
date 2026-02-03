/**
 * Logger Configuration
 * Pino logger with structured logging
 */

import pino from 'pino';
import { env } from './env.js';

const transport =
  env.NODE_ENV === 'development'
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname',
        },
      }
    : undefined;

export const logger = pino({
  name: 'ml-mp-reconciliation',
  level: env.LOG_LEVEL,
  transport,
  base: {
    env: env.NODE_ENV,
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => ({ level: label }),
  },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers["x-api-key"]',
      'accessToken',
      'refreshToken',
      'password',
      'secret',
    ],
    censor: '[REDACTED]',
  },
});

export type Logger = typeof logger;

/**
 * Creates a child logger with additional context
 */
export function createLogger(context: string | Record<string, unknown>) {
  if (typeof context === 'string') {
    return logger.child({ module: context });
  }
  return logger.child(context);
}
