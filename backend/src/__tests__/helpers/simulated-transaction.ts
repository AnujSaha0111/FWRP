import type { NotificationPersistenceClient } from '../../services/notification.service';

// BE-NOTIF-04 test helper: deterministic in-memory stand-in for a Prisma
// transaction boundary. Writes staged through the tx handle become visible
// (committed) only if the unit of work succeeds; any throw discards ALL
// staged writes, modelling atomic commit/rollback semantics at unit level.
//
// This does NOT execute a live PostgreSQL transaction. Real ROLLBACK behavior
// against Supabase remains covered by DB-14 live verification (blocked).

export interface StagedWrite {
  store: 'business' | 'notification';
  data: Record<string, unknown>;
}

export interface SimulatedTxResult<T> {
  result?: T;
  error?: unknown;
  committed: StagedWrite[];
  rolledBack: StagedWrite[];
}

export class SimulatedTx {
  staged: StagedWrite[] = [];
  private counter = 0;

  // Prisma `notification` delegate shape, wired to the staging buffer so
  // notificationService.create(input, tx) participates in this transaction.
  notification = {
    create: async (args: { data: Record<string, unknown> }) => {
      this.counter += 1;
      const row = {
        id: `sim-notif-${this.counter}`,
        isRead: false,
        createdAt: new Date('2026-09-03T00:00:00.000Z'),
        ...args.data,
      };
      this.staged.push({ store: 'notification' as const, data: row });
      return row;
    },
  };

  // Generic stand-in for a business state change (e.g., donation status
  // update) participating in the SAME transaction as the notification write.
  business = {
    apply: async (data: Record<string, unknown>) => {
      this.staged.push({ store: 'business' as const, data: { ...data } });
      return data;
    },
  };

  asPersistenceClient(): NotificationPersistenceClient {
    return this as unknown as NotificationPersistenceClient;
  }
}

export async function runSimulatedTransaction<T>(
  work: (tx: SimulatedTx) => Promise<T>,
): Promise<SimulatedTxResult<T>> {
  const tx = new SimulatedTx();
  try {
    const result = await work(tx);
    const committed = tx.staged;
    tx.staged = [];
    return { result, committed, rolledBack: [] };
  } catch (error) {
    const rolledBack = tx.staged;
    tx.staged = [];
    return { error, committed: [], rolledBack };
  }
}
