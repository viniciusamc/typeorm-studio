import { buildProcessReport } from './process-report.mjs';

const behaviors = new Set(process.argv.slice(2));

process.stdout.write(`pid:${process.pid}\n`);
if (behaviors.has('ignore-sigterm')) {
  process.on('SIGTERM', () => process.stdout.write('sigterm-ignored\n'));
}
if (behaviors.has('exit-on-disconnect')) {
  process.on('disconnect', () => process.exit(0));
}
if (behaviors.has('send-report')) {
  process.send(buildProcessReport());
}
// Also the safety net: a failed test must not leave this process behind forever.
setTimeout(() => process.exit(2), 30_000);
