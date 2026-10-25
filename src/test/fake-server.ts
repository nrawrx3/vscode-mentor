import { createInterface } from 'node:readline';
let thread = 0, turn = 0;
const modes = new Map<string, string>();
const send = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');
const notify = (method: string, params: unknown) => send({ method, params });
const timers = new Map<string, NodeJS.Timeout>();
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  const params = message.params ?? {};
  const reply = (result: unknown) => send({ id: message.id, result });
  switch (message.method) {
    case 'initialize':
      if (process.argv.includes('--slow-init')) { setTimeout(() => reply({ userAgent: 'test' }), 500); }
      else { reply({ userAgent: 'test' }); }
      break;
    case 'model/list': reply({ data: [{ id: 'fixture', model: 'fixture', displayName: 'Fixture', isDefault: true,
      supportedReasoningEfforts: [{ reasoningEffort: 'low' }], defaultReasoningEffort: 'low' }] }); break;
    case 'thread/start': {
      const id = `thread-${++thread}`; modes.set(id, params.sandbox); reply({ thread: { id } }); break;
    }
    case 'turn/start': {
      const id = `turn-${++turn}`, threadId = params.threadId, prompt: string = params.input[0].text;
      if (prompt.includes('CRASH_FIXTURE')) { process.exit(7); }
      notify('turn/started', { threadId, turn: { id } });
      const complete = () => {
        if (prompt.includes('FAIL_FIXTURE')) {
          notify('turn/completed', { threadId, turn: { id, status: 'failed', error: { message: 'fixture failure' } } }); return;
        }
        const text = params.outputSchema?.properties?.steps
          ? JSON.stringify({ steps: [
            { title: 'Write initialization', reason: 'Start with ownership.', file: 'src/app.cpp', line: 1 },
            { title: 'Write cleanup', reason: 'Complete the lifetime.', file: 'src/app.cpp', line: 2 },
          ] })
          : JSON.stringify({ code: prompt.includes('complete replacement') ? 'int answer() { return 42; }' : 'return 42;' });
        notify('item/agentMessage/delta', { threadId, turnId: id, delta: text });
        notify('item/completed', { threadId, turnId: id, item: { id: 'msg', type: 'agentMessage', phase: 'final_answer', text } });
        notify('turn/completed', { threadId, turn: { id, status: 'completed' } });
      };
      if (prompt.includes('DELAY_FIXTURE')) { timers.set(id, setTimeout(complete, 500)); }
      else { complete(); } // Deliberately finish before the turn/start RPC response.
      reply({ turn: { id, status: 'inProgress' } });
      break;
    }
    case 'turn/interrupt':
      clearTimeout(timers.get(params.turnId));
      notify('turn/completed', { threadId: params.threadId, turn: { id: params.turnId, status: 'interrupted' } }); reply({}); break;
    case 'thread/unsubscribe': reply({}); break;
    default: if (message.id !== undefined) { reply({}); }
  }
});
