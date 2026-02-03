/**
 * Server Entry Point
 */

import { buildApp, connectDatabase, disconnectDatabase } from './app.js';
import { env } from './config/env.js';
import { logger } from './config/logger.js';

async function main() {
  logger.info({ environment: env.NODE_ENV }, '🚀 Starting ML-MP Reconciliation API...');

  try {
    // Connect to database
    await connectDatabase();

    const app = await buildApp();

    await app.listen({
      port: env.PORT,
      host: '0.0.0.0',
    });

    logger.info({ port: env.PORT }, `✅ Server running on http://localhost:${env.PORT}`);

    // Graceful shutdown
    const shutdown = async (signal: string) => {
      logger.info({ signal }, 'Shutting down gracefully...');
      await app.close();
      await disconnectDatabase();
      logger.info('👋 Goodbye!');
      process.exit(0);
    };

    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    process.on('SIGINT', () => void shutdown('SIGINT'));
  } catch (error) {
    logger.fatal({ error }, 'Failed to start server');
    process.exit(1);
  }
}

void main();
