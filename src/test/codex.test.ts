import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { CodexClient, Cancelled, RunOptions } from '../codex';
import { codeSchema } from '../contracts';

const client = () => new CodexClient({ command: process.execPath, args: [path.join(__dirname, 'fake-server.js')] });
const options = (prompt = ''): RunOptions => ({ mode: 'suggest', cwd: process.cwd(), prompt, schema: codeSchema,
  effort: 'low', signal: new AbortController().signal, timeoutMs: 2000 });

test('handles completion before RPC response and reuses the connection', async () => {
  const backend = client();
  try {
    assert.equal((await backend.run(options())).text, '{"code":"return 42;"}');
    assert.equal((await backend.run(options())).text, '{"code":"return 42;"}');
  } finally { backend.dispose(); }
});
test('aborts in flight and can serve another request', async () => {
  const backend = client();
  try {
    await backend.models();
    const controller = new AbortController();
    const response = backend.run({ ...options('DELAY_FIXTURE'), signal: controller.signal });
    setTimeout(() => controller.abort(), 80);
    await assert.rejects(response, Cancelled);
    assert.match((await backend.run(options())).text, /42/);
  } finally { backend.dispose(); }
});
test('reports timeout, model errors, server exit and failed turns', async () => {
  const backend = client();
  try {
    await assert.rejects(backend.run({ ...options(), model: 'missing' }), /unavailable/);
    await assert.rejects(backend.run({ ...options('DELAY_FIXTURE'), timeoutMs: 50 }), /timed out/);
    await assert.rejects(backend.run(options('FAIL_FIXTURE')), /fixture failure/);
    await assert.rejects(backend.run(options('CRASH_FIXTURE')), /exited/);
    assert.match((await backend.run(options())).text, /42/);
  } finally { backend.dispose(); }
});
test('pre-cancelled work never starts', async () => {
  const backend = client();
  const controller = new AbortController(); controller.abort();
  try { await assert.rejects(backend.run({ ...options(), signal: controller.signal }), Cancelled); }
  finally { backend.dispose(); }
});
test('the deadline also bounds server startup', async () => {
  const backend = new CodexClient({ command: process.execPath, args: [path.join(__dirname, 'fake-server.js'), '--slow-init'] });
  const start = performance.now();
  try {
    await assert.rejects(backend.run({ ...options(), timeoutMs: 50 }), /timed out/);
    assert.ok(performance.now() - start < 400);
  } finally { backend.dispose(); }
});
