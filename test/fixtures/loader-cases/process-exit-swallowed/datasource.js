import { DataSource } from 'typeorm';

try {
  process.exit(3);
} catch {
  // keeps going as if the call had been a no-op
}

export default new DataSource({
  type: 'postgres',
  host: '127.0.0.1',
  port: 55520,
  username: 'case_user',
  password: 'case-password-swallowed-1180',
  database: 'case_swallowed_db',
});
