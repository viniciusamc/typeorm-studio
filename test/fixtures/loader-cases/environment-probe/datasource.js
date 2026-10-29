import { DataSource } from 'typeorm';

const seen = [
  process.env.NODE_ENV,
  process.env.PORT,
  process.env.TYPEORM_STUDIO,
  process.env.DOTENV_CONFIG_QUIET,
  process.env.NODE_OPTIONS ?? 'unset',
  process.env.CASE_PASSTHROUGH,
].join('|');

export default new DataSource({
  type: 'postgres',
  host: '127.0.0.1',
  port: 55510,
  username: 'case_user',
  password: 'case-password-probe-5902',
  database: 'case_probe_db',
  applicationName: seen,
});
