import { DataSource } from 'typeorm';

setInterval(() => {}, 1_000);
console.error('fixture: environment is invalid, exiting');
process.exit(1);

export default new DataSource({ type: 'postgres' });
