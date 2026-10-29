export function buildProcessReport() {
  return {
    kind: 'report',
    pid: process.pid,
    cwd: process.cwd(),
    envKeys: Object.keys(process.env).sort(),
    argv: process.argv.slice(2),
    execArgv: process.execArgv,
  };
}
