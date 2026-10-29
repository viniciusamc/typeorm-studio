import { buildProcessReport } from './process-report.mjs';

process.stdout.write(`pid:${process.pid}\n`);
process.send('junk string');
process.send(null);
process.send({ kind: 'report' });
process.send(buildProcessReport());
process.on('disconnect', () => process.exit(0));
