import { DataSource } from 'typeorm';

export const primary = new DataSource({
  type: 'postgres',
  host: '127.0.0.1',
  port: 55504,
  username: 'case_user',
  password: 'case-password-primary-3318',
  database: 'case_primary_db',
});

export const replica = new DataSource({
  type: 'postgres',
  host: '127.0.0.1',
  port: 55505,
  username: 'case_user',
  password: 'case-password-replica-3319',
  database: 'case_replica_db',
});
