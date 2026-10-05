import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { RpcError, createSigner, createUpstream, parseChainId } from './signer.mjs';

export function createHttpServer(signer) {
  return createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    response.setHeader('cache-control', 'no-store');
    if (request.method === 'GET' && request.url === '/health') {
      try {
        await signer.checkChain();
        response.end(JSON.stringify({ status: 'ok', chain_id: Number(signer.chainId), sender: signer.sender, vault: signer.vault }));
      } catch {
        response.statusCode = 503;
        response.end(JSON.stringify({ status: 'unavailable' }));
      }
      return;
    }
    if (request.method !== 'POST' || request.url !== '/') {
      response.statusCode = 404;
      response.end(JSON.stringify({ error: 'Not found' }));
      return;
    }
    let id = null;
    try {
      let size = 0;
      const chunks = [];
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 65_536) throw new RpcError(-32600, 'Request body is too large');
        chunks.push(chunk);
      }
      let payload;
      try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw new RpcError(-32700, 'Invalid JSON'); }
      if (!payload || Array.isArray(payload) || payload.jsonrpc !== '2.0' || typeof payload.method !== 'string'
          || !['string', 'number'].includes(typeof payload.id)) {
        throw new RpcError(-32600, 'Expected a single JSON-RPC request with an ID');
      }
      id = payload.id;
      const result = await signer.handle(payload.method, payload.params ?? []);
      response.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
    } catch (error) {
      // Never serialize unexpected Error objects or provider details.
      const safe = error instanceof RpcError ? error : new RpcError(-32603, 'Signer request failed');
      response.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: safe.code, message: safe.message } }));
    }
  });
}

async function main() {
  const signer = createSigner({
    privateKey: process.env.ZKAPI_CHALLENGE_PRIVATE_KEY,
    chainId: parseChainId(process.env.ZKAPI_CHALLENGE_CHAIN_ID),
    vault: process.env.ZKAPI_CHALLENGE_VAULT,
    rpc: createUpstream(process.env.ZKAPI_SIGNER_UPSTREAM_RPC_URL || process.env.ZKAPI_CHALLENGE_RPC_URL),
    maxGas: BigInt(process.env.ZKAPI_CHALLENGE_MAX_GAS ?? '12000000'),
    maxGasPrice: BigInt(process.env.ZKAPI_CHALLENGE_MAX_GAS_PRICE_WEI ?? '10000000000'),
  });
  delete process.env.ZKAPI_CHALLENGE_PRIVATE_KEY;
  await signer.checkChain();
  const server = createHttpServer(signer);
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  const port = Number(process.env.ZKAPI_CHALLENGE_PORT ?? '8547');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
  server.listen(port, process.env.ZKAPI_CHALLENGE_LISTEN_HOST ?? '127.0.0.1', () => {
    console.log(JSON.stringify({ status: 'listening', chain_id: Number(signer.chainId), sender: signer.sender, vault: signer.vault }));
  });
  process.on('SIGTERM', () => server.close());
  process.on('SIGINT', () => server.close());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('Challenge signer startup failed; check its private configuration and upstream RPC.'); process.exitCode = 1; });
}
