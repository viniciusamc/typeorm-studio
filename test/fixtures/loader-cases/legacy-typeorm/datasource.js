const { DataSource } = require('typeorm-0.3');

module.exports.legacyDataSource = new DataSource({
  type: 'postgres',
  host: '127.0.0.1',
  port: 55517,
  username: 'case_user',
  password: 'case-password-legacy-0764',
  database: 'case_legacy_db',
});
