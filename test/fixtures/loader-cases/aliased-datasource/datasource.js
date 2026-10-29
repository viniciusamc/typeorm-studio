import { DataSource } from 'typeorm';

const appDataSource = new DataSource({
  type: 'postgres',
  host: '127.0.0.1',
  port: 55506,
  username: 'case_user',
  password: 'case-password-aliased-7741',
  database: 'case_aliased_db',
});

export default appDataSource;
export { appDataSource as migrationDataSource };
