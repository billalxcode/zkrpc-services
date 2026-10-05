import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Transaction, Wallet } from 'ethers';
import { RpcError, createSigner, createUpstream, parseChainId, vaultInterface } from './signer.mjs';
import { createHttpServer } from './server.mjs';

const CHAIN_ID = 11155111n;

// Public test key; never used or funded outside these offline tests.
const key = `0x${'1'.padStart(64, '0')}`;
const sender = new Wallet(key).address;
const vault = '0x0000000000000000000000000000000000001234';
const proof = `0x${'00'.repeat(256)}`;
const inputs = [2, CHAIN_ID, vault, 0, 1, 2, 0, 1, 0, 0, 0, 0];
const data = vaultInterface.encodeFunctionData('challengeEscapeWithdrawal', [0, inputs, proof, Array(32).fill(0)]);
const validTx = { from: sender, to: vault, data, gas: '0x7a1200', nonce: '0x4' };

function fixture(overrides = {}, options = {}) {
  const calls = [];
  const answers = {
    eth_chainId: `0x${CHAIN_ID.toString(16)}`,
    eth_call: '0x', eth_estimateGas: '0x6acfc0', eth_gasPrice: '0x3b9aca00',
    eth_sendRawTransaction: `0x${'ab'.repeat(32)}`, eth_blockNumber: '0x1',
    ...overrides,
  };
  const rpc = async (method, params) => {
    calls.push({ method, params });
    if (answers[method] instanceof Error) throw answers[method];
    assert.ok(Object.hasOwn(answers, method), `Unexpected RPC method ${method}`);
    return answers[method];
  };
  return { calls, signer: createSigner({ privateKey: key, vault, rpc, chainId: CHAIN_ID, ...options }) };
}

test('signs only the bounded Sepolia challenge, preserving caller nonce', async () => {
  const { signer, calls } = fixture();
  const hash = await signer.handle('eth_sendTransaction', [validTx]);
  assert.equal(hash, `0x${'ab'.repeat(32)}`);
  assert.deepEqual(calls.map(c => c.method), ['eth_chainId', 'eth_call', 'eth_estimateGas', 'eth_gasPrice', 'eth_sendRawTransaction']);
  const signed = Transaction.from(calls.at(-1).params[0]);
  assert.equal(signed.from, sender);
  assert.equal(signed.chainId, CHAIN_ID);
  assert.equal(signed.to.toLowerCase(), vault);
  assert.equal(signed.value, 0n);
  assert.equal(signed.nonce, 4);
  assert.equal(signed.data, data);
  assert.equal(signed.gasLimit, 8_000_000n);
  assert.equal(signed.gasPrice, 1_000_000_000n);
});

test('rejects unauthorized transaction changes before any RPC or signature', async () => {
  const modifications = [
    { from: vault }, { to: sender }, { to: null }, { value: '0x1' }, { chainId: '0x1' },
    { data: '0xdeadbeef' }, { data: `${data}00` }, { gas: '0xffffffff' },
    { nonce: undefined }, { nonce: '0xffffffffffffffff' }, { nonce: '0x04' },
    { gasPrice: '0x1' }, { accessList: [] }, { authorizationList: [] },
    { data: vaultInterface.encodeFunctionData('challengeEscapeWithdrawal', [0, [2, 1, vault, ...inputs.slice(3)], proof, Array(32).fill(0)]) },
    { data: vaultInterface.encodeFunctionData('challengeEscapeWithdrawal', [0, [2, CHAIN_ID, sender, ...inputs.slice(3)], proof, Array(32).fill(0)]) },
    { data: vaultInterface.encodeFunctionData('challengeEscapeWithdrawal', [0, inputs, '0x00', Array(32).fill(0)]) },
  ];
  for (const modification of modifications) {
    const { signer, calls } = fixture();
    await assert.rejects(signer.handle('eth_sendTransaction', [{ ...validTx, ...modification }]), RpcError);
    assert.equal(calls.length, 0);
  }
});

test('upstream wrong chain, failed simulation, excessive fees and changed estimate never broadcast', async () => {
  for (const overrides of [
    { eth_chainId: '0x1' }, { eth_call: new RpcError(-32000, 'Simulation failed') },
    { eth_gasPrice: '0xffffffffffff' }, { eth_estimateGas: '0xffffff' },
  ]) {
    const { signer, calls } = fixture(overrides);
    await assert.rejects(signer.handle('eth_sendTransaction', [validTx]));
    assert.ok(!calls.some(call => call.method === 'eth_sendRawTransaction'));
  }
});

test('ambiguous sends retain the caller nonce and retry queue remains usable', async () => {
  const { signer, calls } = fixture({ eth_sendRawTransaction: new RpcError(-32000, 'Unavailable') });
  await assert.rejects(signer.handle('eth_sendTransaction', [validTx]));
  await assert.rejects(signer.handle('eth_sendTransaction', [validTx]));
  const sends = calls.filter(call => call.method === 'eth_sendRawTransaction');
  assert.equal(sends.length, 2);
  assert.equal(sends[0].params[0], sends[1].params[0]);
  assert.equal(Transaction.from(sends[1].params[0]).nonce, 4);
});

test('an invalid upstream transaction hash remains an ambiguous send error', async () => {
  const { signer, calls } = fixture({ eth_sendRawTransaction: '0x' });
  await assert.rejects(signer.handle('eth_sendTransaction', [validTx]), { code: -32000 });
  assert.equal(calls.at(-1).method, 'eth_sendRawTransaction');
});

test('RPC method allowlist excludes generic signing, account management and raw broadcasts', async () => {
  const { signer, calls } = fixture();
  for (const method of ['eth_sendRawTransaction', 'eth_sign', 'personal_sign', 'eth_signTypedData_v4', 'personal_unlockAccount', 'admin_peers', 'debug_traceCall']) {
    await assert.rejects(signer.handle(method, []), { code: -32601 });
  }
  assert.equal(calls.length, 0);
  assert.equal(await signer.handle('eth_blockNumber', []), '0x1');
});

test('HTTP errors suppress provider details and health detects wrong upstream chain', async t => {
  const secret = 'https://provider.invalid/private-key-material';
  const { signer } = fixture({ eth_blockNumber: new Error(secret) });
  const server = createHttpServer(signer).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = value => fetch(base, { method: 'POST', body: JSON.stringify(value) }).then(r => r.json());
  const health = await fetch(`${base}/health`).then(r => r.json());
  assert.equal(health.status, 'ok');
  assert.equal(health.chain_id, Number(CHAIN_ID));
  const failed = await post({ jsonrpc: '2.0', id: 8, method: 'eth_blockNumber', params: [] });
  assert.deepEqual(failed, { jsonrpc: '2.0', id: 8, error: { code: -32603, message: 'Signer request failed' } });
  assert.ok(!JSON.stringify(failed).includes(secret));
  assert.equal((await post([])).error.code, -32600);
  assert.equal((await post({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: {} })).error.code, -32602);
  const wrong = createHttpServer(fixture({ eth_chainId: '0x1' }).signer).listen(0, '127.0.0.1');
  await once(wrong, 'listening');
  t.after(() => wrong.close());
  assert.equal((await fetch(`http://127.0.0.1:${wrong.address().port}/health`)).status, 503);
});

test('upstream enforces encrypted remote transport and sanitizes network errors', async () => {
  assert.throws(() => createUpstream('http://remote.invalid/private-api-key'));
  const rpc = createUpstream('http://127.0.0.1:1/private-api-key');
  await assert.rejects(rpc('eth_chainId', []), { code: -32000, message: 'Upstream RPC request failed' });
});


test('requires an explicit supported chain without a Sepolia fallback', () => {
  for (const value of [undefined, null, '', '01', '0x1', '11155111 ', '137', '46630', 1]) assert.throws(() => parseChainId(value));
  assert.equal(parseChainId('1'), 1n);
  assert.equal(parseChainId('11155111'), 11155111n);
assert.equal(parseChainId('4663'), 4663n);
  for (const chainId of [undefined, 1, '1', 0n, 137n]) assert.throws(() => fixture({}, { chainId }), RpcError);
});

test('Mainnet and Sepolia preserve chain-specific signatures, proof bindings and fee bounds', async () => {
  for (const chainId of [1n, 11155111n]) {
    const other = chainId === 1n ? 11155111n : 1n;
    const chainHex = `0x${chainId.toString(16)}`;
    const selectedData = vaultInterface.encodeFunctionData('challengeEscapeWithdrawal', [0, [2, chainId, vault, ...inputs.slice(3)], proof, Array(32).fill(0)]);
    const transaction = { ...validTx, data: selectedData, chainId: chainHex };
    const { signer, calls } = fixture({ eth_chainId: chainHex }, { chainId });
    await signer.handle('eth_sendTransaction', [transaction]);
    assert.equal(signer.chainId, chainId);
    assert.equal(Transaction.from(calls.at(-1).params[0]).chainId, chainId);
    const baseline = calls.length;
    await assert.rejects(signer.handle('eth_sendTransaction', [{ ...transaction, chainId: `0x${other.toString(16)}` }]), RpcError);
    const wrongData = vaultInterface.encodeFunctionData('challengeEscapeWithdrawal', [0, [2, other, vault, ...inputs.slice(3)], proof, Array(32).fill(0)]);
    await assert.rejects(signer.handle('eth_sendTransaction', [{ ...transaction, data: wrongData }]), RpcError);
    assert.equal(calls.length, baseline);
    for (const overrides of [{ eth_chainId: `0x${other.toString(16)}` }, { eth_gasPrice: '0xffffffffffff' }, { eth_estimateGas: '0xffffff' }]) {
      const denied = fixture({ eth_chainId: chainHex, ...overrides }, { chainId });
      await assert.rejects(denied.signer.handle('eth_sendTransaction', [transaction]), RpcError);
      assert.ok(!denied.calls.some(call => call.method === 'eth_sendRawTransaction'));
    }
  }
});

test('Mainnet health advertises only its explicitly configured chain', async t => {
  const { signer } = fixture({ eth_chainId: '0x1' }, { chainId: 1n });
  const server = createHttpServer(signer).listen(0, '127.0.0.1');
  await once(server, 'listening'); t.after(() => server.close());
  const response = await fetch(`http://127.0.0.1:${server.address().port}/health`).then(r => r.json());
  assert.equal(response.chain_id, 1);
});
