import { basename } from 'node:path';
import { DataSource } from 'typeorm';

const database: string = basename(__dirname);

export default new DataSource({
  type: 'postgres',
  host: '127.0.0.1',
  port: 55516,
  username: 'case_user',
  password: 'case-password-cts-2085',
  database,
});
