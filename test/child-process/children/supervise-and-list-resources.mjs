import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runChildForOneMessage } from '../../../src/child-process/supervise-child.ts';

const childrenDirectory = fileURLToPath(new URL('./', import.meta.url));

function isReport(value) {
  return typeof value === 'object' && value !== null && value.kind === 'report';
}

function superviseChild(entryName, timeoutMs, cwd) {
  return runChildForOneMessage(
    {
      label: entryName,
      entry: path.join(childrenDirectory, entryName),
      entryArguments: [],
      nodeArguments: [],
      cwd,
      environment: {},
    },
    { timeoutMs, isExpectedMessage: isReport },
  );
}

// Destroying any socket makes Node create process.stderr lazily; take it into the baseline.
process.stdout.write('');
process.stderr.write('');
const resourcesBefore = process.getActiveResourcesInfo();
const outcomeKinds = [];
const message = await superviseChild(
  'send-junk-then-report.mjs',
  25_000,
  childrenDirectory,
);
outcomeKinds.push(message.kind);
const exited = await superviseChild(
  'exit-with-stderr.mjs',
  25_000,
  childrenDirectory,
);
outcomeKinds.push(exited.kind);
const timedOut = await superviseChild('hang.mjs', 400, childrenDirectory);
outcomeKinds.push(timedOut.kind);
try {
  await superviseChild(
    'hang.mjs',
    25_000,
    path.join(childrenDirectory, 'missing'),
  );
} catch {
  outcomeKinds.push('rejected');
}

// Closing handles are still listed for a few loop turns after their owner settled.
await new Promise((resolve) => setTimeout(resolve, 200));
const resourcesAfter = process.getActiveResourcesInfo();
process.stdout.write(
  `${JSON.stringify({ outcomeKinds, resourcesBefore, resourcesAfter })}\n`,
);
