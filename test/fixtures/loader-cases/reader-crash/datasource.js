import { writeSync } from 'node:fs';

writeSync(
  2,
  `fixture crash: token=${process.env.CASE_API_TOKEN} url=postgres://app_user:case-url-password-3319@db.example.test/app\n`,
);
process.kill(process.pid, 'SIGKILL');
