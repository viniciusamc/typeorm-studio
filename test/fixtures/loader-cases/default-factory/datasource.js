import { DataSource } from 'typeorm';

globalThis.fixtureFactoryCalls = 0;

export default async function buildDataSource() {
  globalThis.fixtureFactoryCalls += 1;
  return new DataSource({
    type: 'postgres',
    host: '127.0.0.1',
    port: 55502,
    username: 'case_user',
    password: 'case-password-factory-2290',
    database: 'case_factory_db',
    applicationName: `factory-call-${globalThis.fixtureFactoryCalls}`,
  });
}
