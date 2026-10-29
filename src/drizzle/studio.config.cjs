'use strict';
// A static file instead of a generated one, so nothing is written to disk. The
// password is not here: pg reads it from PGPASSWORD, which also keeps it out of
// drizzle's dbHash.
module.exports = {
  dialect: 'postgresql',
  dbCredentials: JSON.parse(process.env.TYPEORM_STUDIO_DATABASE ?? 'null'),
};
