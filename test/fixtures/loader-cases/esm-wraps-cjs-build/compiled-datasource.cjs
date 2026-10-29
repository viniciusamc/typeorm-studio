const { DataSource } = require('typeorm');

exports.__esModule = true;
exports.default = new DataSource({
  type: 'postgres',
  host: '127.0.0.1',
  port: 55513,
  username: 'case_user',
  password: 'case-password-wrapped-9253',
  database: 'case_wrapped_db',
});
