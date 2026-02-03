import { PrismaClient } from '@prisma/client';
import { logger } from '../../config/logger.js';

const log = logger.child({ module: 'prisma' });

declare global {
  // eslint-disable-next-line no-var
  var prisma: PrismaClient | undefined;
}

const createPrismaClient = (): PrismaClient => {
  const client = new PrismaClient({
    log: [
      { emit: 'event', level: 'query' },
      { emit: 'event', level: 'error' },
      { emit: 'event', level: 'info' },
      { emit: 'event', level: 'warn' },
    ],
  });

  // Log queries in development
  if (process.env.NODE_ENV === 'development') {
    client.$on('query', (e) => {
      log.debug({ duration: e.duration, query: e.query }, 'Prisma Query');
    });
  }

  client.$on('error', (e) => {
    log.error({ message: e.message }, 'Prisma Error');
  });

  client.$on('warn', (e) => {
    log.warn({ message: e.message }, 'Prisma Warning');
  });

  return client;
};

// Prevent multiple instances of Prisma Client in development
export const prisma = globalThis.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== 'production') {
  globalThis.prisma = prisma;
}

export async function connectDatabase(): Promise<void> {
  try {
    await prisma.$connect();
    log.info('✅ Database connected');
  } catch (error) {
    log.error({ error }, '❌ Failed to connect to database');
    throw error;
  }
}

export async function disconnectDatabase(): Promise<void> {
  try {
    await prisma.$disconnect();
    log.info('Database disconnected');
  } catch (error) {
    log.error({ error }, 'Failed to disconnect from database');
    throw error;
  }
}

export { PrismaClient };
