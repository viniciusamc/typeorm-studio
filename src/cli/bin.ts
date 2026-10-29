#!/usr/bin/env node
import { runCli } from './run-cli.ts';

process.exitCode = await runCli({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  shellEnv: process.env,
  nodeVersion: process.versions.node,
  stdout: process.stdout,
  stderr: process.stderr,
});
