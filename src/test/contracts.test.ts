import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parseCode, parseSteps, insideRoot, isCurrent } from '../contracts';

test('twenty-line cap counts blank lines and rejects instead of truncating', () => {
  const code = Array(20).fill('x();').join('\n');
  assert.equal(parseCode(JSON.stringify({ code }), 20), code);
  assert.throws(() => parseCode(JSON.stringify({ code: code + '\n' }), 20), /20-line/);
  assert.equal(parseCode('{"code":""}', 20), '');
  assert.equal(parseCode(JSON.stringify({ code: 'a\r\nb' }), 20), 'a\nb');
});
test('malformed code and prose cannot become ghost text', () => {
  for (const value of ['not JSON', '{}', '{"code":1}', JSON.stringify({ code: '```cpp\nx();\n```' }), JSON.stringify({ code: '\0' })]) {
    assert.throws(() => parseCode(value));
  }
});
test('navigation rejects path traversal, absolute paths and malformed two-step output', () => {
  const root = path.resolve('workspace');
  for (const file of ['../escape.cpp', '/outside.cpp', 'C:\\outside.cpp', 'https://example.com', '']) {
    assert.throws(() => insideRoot(root, file));
  }
  const step = { title: 'Implement wait', reason: 'Protect reuse.', file: 'src/app.cpp', line: 3 };
  assert.equal(parseSteps(JSON.stringify({ steps: [step, step] }), root).length, 2);
  for (const steps of [[step], [step, { ...step, line: 0 }], [step, { ...step, file: '../x' }]]) {
    assert.throws(() => parseSteps(JSON.stringify({ steps }), root));
  }
});
test('a response belongs to one URI, document version, and cursor offset', () => {
  const original = { uri: 'file:///a.cpp', version: 7, offset: 31 };
  assert.equal(isCurrent(original, { ...original }), true);
  for (const next of [{ ...original, uri: 'file:///b.cpp' }, { ...original, version: 8 }, { ...original, offset: 32 }]) {
    assert.equal(isCurrent(original, next), false);
  }
});
