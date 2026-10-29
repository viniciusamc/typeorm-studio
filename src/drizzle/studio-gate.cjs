'use strict';
// Preloaded into the drizzle-kit process. drizzle-kit answers any Origin with
// CORS `*`, so without this gate every web page could run SQL on the database.
const net = require('node:net');

const allowedOrigin = 'https://local.drizzle.studio';
const loopbackHostnames = new Set(['localhost', '127.0.0.1', '[::1]']);
const channel = 'typeorm-studio/engine';
const originalListen = net.Server.prototype.listen;
let listenCount = 0;

function refuseToListen(reason) {
  process.send?.({ channel, kind: 'gate-refused', reason });
  process.stderr.write(`typeorm-studio gate: ${reason}\n`);
  process.exit(70);
}

function isAllowedRequest(request) {
  const hostname = (request.headers.host ?? '').replace(/:\d+$/, '');
  return (
    request.headers.origin === allowedOrigin && loopbackHostnames.has(hostname)
  );
}

// Fails closed: a second server, or one whose handler is attached after
// listen(), could not be gated, so the engine refuses to start at all.
net.Server.prototype.listen = function listenThroughGate(...listenArguments) {
  listenCount += 1;
  if (listenCount > 1) {
    return refuseToListen('the engine tried to open a second listening socket');
  }
  const requestListeners = this.listeners('request');
  if (requestListeners.length === 0) {
    return refuseToListen('the engine server has no request handler to gate');
  }
  this.removeAllListeners('request');
  this.on('request', (request, response) => {
    if (!isAllowedRequest(request)) {
      response.writeHead(403, { 'content-type': 'application/json' });
      response.end('{"error":"forbidden"}');
      return;
    }
    for (const listener of requestListeners) {
      listener.call(this, request, response);
    }
  });
  this.once('listening', () => {
    process.send?.({ channel, kind: 'listening', address: this.address() });
  });
  this.once('error', (error) => {
    process.send?.({ channel, kind: 'listen-failed', code: error.code });
  });
  return originalListen.apply(this, listenArguments);
};

// The IPC channel closes when the launcher dies, even by SIGKILL.
process.on('disconnect', () => process.exit(0));
