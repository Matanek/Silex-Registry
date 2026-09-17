import { createServer } from 'node:http';

const upstream = process.env.PROBE_UPSTREAM;
const port = Number(process.env.PROBE_PROXY_PORT ?? '8793');
if (upstream !== 'https://silex-registry-staging-probe.silex-lang.workers.dev' ||
    !Number.isSafeInteger(port) || port < 1 || port > 65535) {
  throw new Error('invalid probe proxy configuration');
}

const excluded = new Set(['connection', 'host', 'transfer-encoding', 'content-length']);
const server = createServer(async (request, response) => {
  try {
    const input = [];
    for await (const chunk of request) input.push(chunk);
    const body = Buffer.concat(input);
    const headers = Object.fromEntries(Object.entries(request.headers)
      .filter(([name]) => !excluded.has(name)));
    headers['accept-encoding'] = 'identity';
    const remote = await fetch(`${upstream}${request.url}`, {
      method: request.method, headers,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : body,
      redirect: 'manual',
    });
    const outputHeaders = Object.fromEntries([...remote.headers]
      .filter(([name]) => !excluded.has(name) && name !== 'content-encoding'));
    outputHeaders['content-encoding'] = 'identity';
    const bytes = request.method === 'HEAD' ? null : Buffer.from(await remote.arrayBuffer());
    if (bytes) outputHeaders['content-length'] = String(bytes.length);
    response.writeHead(remote.status, outputHeaders);
    response.end(bytes);
  } catch {
    response.writeHead(502, { 'content-type': 'application/json' });
    response.end('{"error":"edge_probe_proxy_failed"}');
  }
});
server.listen(port, '127.0.0.1', () => {
  console.log(JSON.stringify({ proxy: `http://127.0.0.1:${port}`, upstream }));
});
