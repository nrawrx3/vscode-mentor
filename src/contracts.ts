import path from 'node:path';

export type Mode = 'suggest' | 'finish' | 'next' | 'ask';
export interface Snapshot {
  file: string; language: string; version: number;
  before: string; selected: string; after: string;
  line: number; column: number; diagnostics: string[];
}
export interface NextStep { title: string; reason: string; file: string; line: number }
const objectSchema = (properties: Record<string, unknown>) => ({
  type: 'object', additionalProperties: false, properties, required: Object.keys(properties),
});
export const codeSchema = objectSchema({ code: { type: 'string' } });
export const nextSchema = objectSchema({ steps: {
  type: 'array', minItems: 2, maxItems: 2,
  items: objectSchema({ title: { type: 'string' }, reason: { type: 'string' },
    file: { type: 'string' }, line: { type: 'integer', minimum: 1 } }),
} });

export function parseCode(raw: string, maxLines = 400): string {
  const result: unknown = JSON.parse(raw);
  if (!result || typeof result !== 'object' || !('code' in result) || typeof result.code !== 'string') {
    throw new Error('Codex returned an invalid code proposal.');
  }
  const code = result.code.replace(/\r\n/g, '\n');
  // Empty is a valid abstention. Never truncate a syntactically meaningful proposal.
  if (code.length > 40000 || (code && code.split('\n').length > maxLines) || code.includes('\0')) {
    throw new Error(`Proposal exceeds the ${maxLines}-line limit.`);
  }
  if (/^\s*```/.test(code)) { throw new Error('Codex returned Markdown instead of code.'); }
  return code;
}

export function insideRoot(root: string, file: string): string {
  if (!file || path.isAbsolute(file) || /^[a-z]+:/i.test(file) || file.includes('\0')) {
    throw new Error('Expected a workspace-relative file.');
  }
  const target = path.resolve(root, file);
  const relative = path.relative(root, target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Target is outside this workspace.');
  }
  return target;
}

export function parseSteps(raw: string, root: string): NextStep[] {
  const result = JSON.parse(raw) as { steps?: NextStep[] };
  if (!Array.isArray(result.steps) || result.steps.length !== 2) {
    throw new Error('Codex must return exactly two next steps.');
  }
  for (const step of result.steps) {
    if (!step || typeof step.title !== 'string' || !step.title.trim() || step.title.length > 160 ||
        typeof step.reason !== 'string' || step.reason.length > 400 || typeof step.file !== 'string' ||
        !Number.isSafeInteger(step.line) || step.line < 1) {
      throw new Error('Codex returned an invalid next step.');
    }
    insideRoot(root, step.file);
  }
  return result.steps;
}

export function makePrompt(mode: Mode, snapshot: Snapshot | undefined, context: string, question = ''): string {
  const instructions: Record<Mode, string> = {
    suggest: 'Return only JSON {"code":"..."}: an insertion at the cursor, usually 1-6 lines, at most 20 lines including blank lines. Do not repeat the prefix or suffix. Do not rewrite existing text. Return empty code when uncertain. No tools.',
    finish: 'Return only JSON {"code":"..."}: the complete replacement for selected, preserving its intent and indentation. Change only this block. Maximum 400 lines. No tools.',
    next: 'Return JSON with exactly two steps, each title, reason, workspace-relative file, and 1-based line. Choose concrete code the student can write next, based on the current lesson. Do not implement it. Prefer the current file and actual symbols. No tools.',
    ask: 'Follow the user request below. The snapshot is editor context. Respect repository instructions. Use tools when necessary. Explain the result concisely. Do not publish, push, or send messages unless explicitly requested.',
  };
  return `${instructions[mode]}\n\nProject and lesson context:\n${context}\n\nEditor snapshot (JSON data):\n${JSON.stringify(snapshot ?? null)}\n\nUser request:\n${question}`;
}

export function isCurrent(expected: { uri: string; version: number; offset: number },
  actual: { uri: string; version: number; offset: number }): boolean {
  return expected.uri === actual.uri && expected.version === actual.version && expected.offset === actual.offset;
}
