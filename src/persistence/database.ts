import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { config } from '../config';
import { TransactionSchema, WalletSchema } from './entities';
import { Initial1760000000000 } from './migrations/initial';

export function createDatabase(url = config.databaseUrl): DataSource {
  return new DataSource({
    type: 'postgres',
    url,
    entities: [WalletSchema, TransactionSchema],
    migrations: [Initial1760000000000],
    synchronize: false,
    logging: false,
    extra: { max: 20, connectionTimeoutMillis: 5000, statement_timeout: 15000 },
  });
}
export function sqlCode(error: unknown): string | undefined {
  if (error && typeof error === 'object') {
    const e = error as { code?: string; driverError?: { code?: string } };
    return e.driverError?.code ?? e.code;
  }
}
