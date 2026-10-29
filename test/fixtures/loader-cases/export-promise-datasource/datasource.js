import { DataSource } from 'typeorm';

export const pendingDataSource = (async () =>
  new DataSource({
    type: 'postgres',
    host: '127.0.0.1',
    port: 55514,
    username: 'case_user',
    password: 'case-password-promise-1376',
    database: 'case_promise_db',
  }))();
