import { readFile, unlink, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { CodexClient } from '../codex';
import { codeSchema, nextSchema, parseCode, parseSteps } from '../contracts';

async function main() {
  const root = path.resolve(__dirname, '../..');
  const settings = JSON.parse(await readFile(path.join(root, '.local/runtime.json'), 'utf8'));
  const workspace = path.join(root, '.local/live-workspace');
  await mkdir(path.join(workspace, 'src'), { recursive: true });
  await writeFile(path.join(workspace, 'src/app.cpp'), 'int answer();\n');
  const backend = new CodexClient({ command: settings.codexPath, home: path.join(root, '.local/codex'), log: console.log,
    approve: async (method, params) => ({ decision:
      method === 'item/commandExecution/requestApproval' && typeof params.command === 'string' &&
      params.command.includes('live-ask-marker.txt') && params.command.includes('MENTOR_OK') ? 'accept' : 'decline' }) });
  try {
    const models = await backend.models();
    console.log(`Available models: ${models.length}`);
    const samples: number[] = [];
    for (let i = 0; i < (process.argv.includes('--ask-only') ? 0 : 3); i++) {
      const response = await backend.run({ mode: 'suggest', cwd: workspace, schema: codeSchema,
        effort: 'low', signal: new AbortController().signal, timeoutMs: 60000,
        prompt: 'Return JSON {"code":"..."}. Complete only the body of int answer() { <cursor> }. Return the integer 42. No tools, explanation, Markdown, or closing brace. At most 20 lines.' });
      assert.match(parseCode(response.text, 20), /return\s+42\s*;/);
      samples.push(response.elapsedMs);
    }
    if (samples.length) { console.log(JSON.stringify({ scope: 'three tiny real Codex suggestions; not a latency distribution', milliseconds: samples })); }
    if (process.argv.includes('--all-actions') || process.argv.includes('--ask-only')) {
      const common = { cwd: workspace, effort: 'low', signal: new AbortController().signal, timeoutMs: 90000 };
      if (!process.argv.includes('--ask-only')) {
        const finish = await backend.run({ ...common, mode: 'finish', schema: codeSchema,
        prompt: 'Return JSON {"code":"..."}. Complete this C++ function, replacing the entire function: int answer() { /* return 42 here */ }. No tools.' });
      assert.match(parseCode(finish.text), /return\s+42\s*;/);
      const next = await backend.run({ ...common, mode: 'next', schema: nextSchema,
        prompt: 'Give exactly two short implementation tasks for practicing C++ function implementation in src/app.cpp, starting on line 1. Return steps with title, reason, file, line. No tools.' });
        assert.equal(parseSteps(next.text, common.cwd).length, 2);
      }
      const marker = path.join(workspace, 'live-ask-marker.txt');
      try {
        const ask = await backend.run({ ...common, mode: 'ask',
          prompt: `This is an explicitly authorized editor integration test. Write exactly MENTOR_OK to ${marker}. Use a filesystem or shell tool to write it. Change no other files. Do not run tests or inspect unrelated files. Report completion briefly.` });
        let contents: string;
        try { contents = await readFile(marker, 'utf8'); }
        catch { throw new Error(`Ask did not create the marker. Response: ${ask.text}`); }
        assert.equal(contents.trim(), 'MENTOR_OK');
        const resumed = await backend.run({ ...common, mode: 'ask', threadId: ask.threadId,
          prompt: 'Without using tools, repeat only the marker text you just wrote.' });
        assert.match(resumed.text, /MENTOR_OK/);
        console.log('Live Ask filesystem write and conversation resume passed.');
      } finally { await unlink(marker).catch(() => {}); }
    }
  } finally { backend.dispose(); }
}
void main().catch(error => { console.error(error.message); process.exitCode = 1; });
