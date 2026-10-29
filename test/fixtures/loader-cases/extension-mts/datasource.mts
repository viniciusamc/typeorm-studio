import { DataSource } from 'typeorm';

const database: string = 'case_mts_db';

export default new DataSource({
  type: 'postgres',
  host: '127.0.0.1',
  port: 55515,
  username: 'case_user',
  password: 'case-password-mts-6630',
  database,
  applicationName: `esm-${typeof import.meta.url}`,
});
