#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { runCli } from './run-cli.ts';

const stopController = new AbortController();
process.once('SIGINT', () => stopController.abort());
process.once('SIGTERM', () => stopController.abort());

const browserOpeners: Partial<Record<NodeJS.Platform, readonly string[]>> = {
  darwin: ['open'],
  win32: ['cmd', '/c', 'start', '""'],
};

function openBrowser(url: string): void {
  const [command = 'xdg-open', ...commandArguments] = browserOpeners[
    process.platform
  ] ?? ['xdg-open'];
  const opener = spawn(command, [...commandArguments, url], {
    detached: true,
    stdio: 'ignore',
  });
  // A missing opener only costs the automatic open; the link is printed anyway.
  opener.on('error', () => {});
  opener.unref();
}

process.exitCode = await runCli({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  shellEnv: process.env,
  nodeVersion: process.versions.node,
  stdout: process.stdout,
  stderr: process.stderr,
  stopSignal: stopController.signal,
  openBrowser,
});
