import { DataSource } from 'typeorm';

export default new DataSource({
  type: 'postgres',
  host: process.env.CASE_DB_HOST,
  port: Number(process.env.CASE_DB_PORT),
  username: process.env.CASE_DB_USER,
  password: process.env.CASE_DB_SECRET,
  database: process.env.CASE_DB_NAME,
});
