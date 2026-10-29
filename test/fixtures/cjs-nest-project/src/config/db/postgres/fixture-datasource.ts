import * as dotenv from 'dotenv';
import { join } from 'path';
import { FixtureCustomer } from 'src/modules/customer/entities/fixture-customer.entity';
import { FixtureOrder } from 'src/modules/order/entities/fixture-order.entity';
import { DataSource } from 'typeorm';

dotenv.config();

const dataSource = new DataSource({
  type: 'postgres',
  host: process.env.FIXTURE_DB_HOST,
  port: Number(process.env.FIXTURE_DB_PORT),
  username: process.env.FIXTURE_DB_USER,
  password: process.env.FIXTURE_DB_PASSWORD,
  database: process.env.FIXTURE_DB_NAME,
  entities: [FixtureCustomer, FixtureOrder],
  synchronize: false,
  migrations: [
    join(__dirname, '../../../../database/fixture/migrations/*{.ts,.js}'),
  ],
  migrationsRun: false,
});

export default dataSource;
