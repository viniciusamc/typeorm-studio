#!/usr/bin/env node
import { runCli } from './run-cli.ts';

const stopController = new AbortController();
process.once('SIGINT', () => stopController.abort());
process.once('SIGTERM', () => stopController.abort());

process.exitCode = await runCli({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  shellEnv: process.env,
  nodeVersion: process.versions.node,
  stdout: process.stdout,
  stderr: process.stderr,
  stopSignal: stopController.signal,
});
