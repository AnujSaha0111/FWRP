import { PrismaClient } from '@prisma/client';
import { env, isDatabaseConfigured } from '../config/env';
import { logger } from '../utils/logger';

let prismaInstance: PrismaClient | null = null;

export function getPrisma(): PrismaClient {
  if (!isDatabaseConfigured()) {
    throw new Error('DATABASE_URL is not configured — Supabase pending');
  }
  if (!prismaInstance) {
    prismaInstance = new PrismaClient({
      log: env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
      // Interactive transactions make one round trip per statement; against a
      // remote pooled database (Supabase) Prisma's 5 s default is too tight for
      // multi-step writes such as acceptance. Applies to every $transaction.
      transactionOptions: { maxWait: 10_000, timeout: 20_000 },
    });
  }
  return prismaInstance;
}

// For tests/health: return null instead of throwing when DB not configured
export function getPrismaIfConfigured(): PrismaClient | null {
  if (!isDatabaseConfigured()) return null;
  return getPrisma();
}

export async function connectWithRetry(retries = 3, delayMs = 1000): Promise<PrismaClient | null> {
  const prisma = getPrismaIfConfigured();
  if (!prisma) {
    logger.info('Database not configured — skipping connection (Supabase pending)');
    return null;
  }
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await prisma.$connect();
      await prisma.$queryRaw`SELECT 1`;
      logger.info({ attempt }, 'Database connected');
      return prisma;
    } catch (err) {
      logger.warn({ attempt, err }, `Database connection attempt ${attempt} failed`);
      if (attempt === retries) throw err;
      await new Promise((r) => setTimeout(r, delayMs * attempt));
    }
  }
  return null;
}

export async function disconnectPrisma(): Promise<void> {
  if (prismaInstance) {
    await prismaInstance.$disconnect();
    prismaInstance = null;
    logger.info('Database disconnected');
  }
}

export async function healthCheckDb(): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
  const prisma = getPrismaIfConfigured();
  if (!prisma) {
    return { ok: false, error: 'not-configured' };
  }
  const start = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export function setupGracefulShutdown(): void {
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Received shutdown signal');
    await disconnectPrisma();
    process.exit(0);
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}
