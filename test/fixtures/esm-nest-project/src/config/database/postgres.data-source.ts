import { resolve } from 'node:path';
import { DataSource } from 'typeorm';
import { FixtureAccount } from '../../account/account.entity.js';
import { FixtureInvoice } from '../../invoice/invoice.entity.js';
import { postgresOptions } from './postgres.options.js';

export default new DataSource({
  ...postgresOptions,
  entities: [FixtureAccount, FixtureInvoice],
  migrations: [
    resolve(import.meta.dirname, '../../database/migrations/*{.ts,.js}'),
  ],
});
