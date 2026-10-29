const { DataSource } = require('typeorm');

module.exports = new DataSource({
  type: 'postgres',
  host: '127.0.0.1',
  port: 55511,
  username: 'case_user',
  password: 'case-password-cjs-instance-8826',
  database: 'case_cjs_instance_db',
});
