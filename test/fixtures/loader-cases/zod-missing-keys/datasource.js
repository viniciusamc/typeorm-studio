import { DataSource } from 'typeorm';
import { z } from 'zod';

const envSchema = z.object({
  CASE_DB_HOST: z.string(),
  CASE_DB_PORT: z.coerce.number().int().positive(),
  CASE_DB_LABEL: z.string().min(40, {
    error: (issue) => `label "${issue.input}" is shorter than 40 characters`,
  }),
});

const env = envSchema.parse(process.env);

export default new DataSource({
  type: 'postgres',
  host: env.CASE_DB_HOST,
  port: env.CASE_DB_PORT,
});
