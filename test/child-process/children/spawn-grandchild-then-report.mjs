import { spawn } from 'node:child_process';
import { buildProcessReport } from './process-report.mjs';

const grandchildCode = `
  setTimeout(() => process.stdout.write('late grandchild line\\n'), 300);
  setTimeout(() => {}, 4000);
`;
const grandchild = spawn(process.execPath, ['-e', grandchildCode], {
  stdio: 'inherit',
});
process.stdout.write(`grandchild:${grandchild.pid}\n`);
process.send(buildProcessReport());
process.on('disconnect', () => process.exit(0));
