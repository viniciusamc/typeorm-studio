import type { DataSourceOptions } from 'typeorm';
import { env } from '../env/env.js';

class ApplicationNameBuilder {
  constructor(
    private readonly service: string,
    private readonly stage: string,
  ) {}

  build(): string {
    return `${this.service}-${this.stage}`;
  }
}

export const postgresOptions: DataSourceOptions = {
  type: 'postgres',
  host: env.POSTGRES_HOST,
  port: env.POSTGRES_PORT,
  username: env.POSTGRES_USER,
  password: env.POSTGRES_PASSWORD,
  database: env.POSTGRES_DB,
  applicationName: new ApplicationNameBuilder(
    'fixture-api',
    env.NODE_ENV,
  ).build(),
  synchronize: false,
};
