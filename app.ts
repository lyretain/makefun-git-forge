// HTTP front door. The suite dials this process; main.ts owns the register/done lifecycle.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge, type Reply } from './forge.ts';

const MAX_BODY = 64 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value[0];
  return undefined;
}

function send(res: ServerResponse, reply: Reply, requestId: string): void {
  const headers: Record<string, string | number> = { 'x-github-request-id': requestId, ...(reply.headers ?? {}) };
  if (reply.json !== undefined) {
    const body = JSON.stringify(reply.json);
    if (headers['content-type'] === undefined) headers['content-type'] = 'application/json; charset=utf-8';
    res.writeHead(reply.status, headers);
    res.end(body);
    return;
  }
  res.writeHead(reply.status, headers);
  res.end(reply.body ?? '');
}

export function createApp(): Server {
  const forge = new Forge(process.env.MAKEFUN_SHOP_TOKEN ?? '');
  let seq = 0;
  const server = createServer((req, res) => {
    seq += 1;
    const requestId = seq.toString(16).padStart(8, '0');
    void (async () => {
      try {
        const host = header(req, 'host') ?? '127.0.0.1';
        const url = new URL(req.url ?? '/', `http://${host}`);
        const path = url.pathname
          .split('/')
          .map((segment) => {
            try {
              return decodeURIComponent(segment);
            } catch {
              return segment;
            }
          })
          .join('/');
        const body = await readBody(req);
        const reply = forge.handle({
          method: req.method ?? 'GET',
          path,
          query: url.searchParams,
          authorization: header(req, 'authorization'),
          gitProtocol: header(req, 'git-protocol'),
          host,
          body,
        });
        send(res, reply, requestId);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'internal error';
        send(res, { status: 500, json: { message } }, requestId);
      }
    })();
  });
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  server.keepAliveTimeout = 60_000;
  return server;
}
