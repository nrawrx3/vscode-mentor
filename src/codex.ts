import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { Mode } from './contracts';

type Wire = Record<string, any>; // Boundary with the versioned JSON-RPC protocol; validated at use sites.
interface Pending { resolve(value: Wire): void; reject(error: Error): void; timer: NodeJS.Timeout }
export interface Model {
  id: string; model: string; displayName: string; isDefault: boolean;
  defaultReasoningEffort: string; supportedReasoningEfforts: { reasoningEffort: string }[];
}
export interface ClientOptions {
  command: string; args?: string[]; home?: string;
  log?: (message: string) => void;
  approve?: (method: string, params: Wire) => Promise<Wire>;
}
export interface RunOptions {
  mode: Mode; cwd: string; prompt: string; schema?: unknown; model?: string; effort?: string;
  signal: AbortSignal; timeoutMs: number; threadId?: string;
  onText?: (text: string) => void;
}
export class Cancelled extends Error { constructor() { super('Cancelled'); this.name = 'Cancelled'; } }

export class CodexClient {
  private child?: ChildProcessWithoutNullStreams;
  private ready?: Promise<void>;
  private pending = new Map<number, Pending>();
  private nextId = 0;
  private listeners = new Set<(method: string, params: Wire) => void>();
  private modes = new Map<string, Mode>();
  private modelCache?: Model[];
  constructor(private readonly options: ClientOptions) {}

  private async start(): Promise<void> {
    if (!this.ready) {
      this.ready = this.boot().catch(error => { this.dispose(); throw error; });
    }
    return this.ready;
  }

  private async boot(): Promise<void> {
    const child = spawn(this.options.command, [...(this.options.args ?? []), 'app-server'], {
      stdio: 'pipe', windowsHide: true, shell: false,
      env: { ...process.env, ...(this.options.home ? { CODEX_HOME: this.options.home } : {}),
        // Also permits a Node-based fixture in VS Code's Electron extension test host.
        ELECTRON_RUN_AS_NODE: '1' },
    });
    this.child = child;
    const reader = createInterface({ input: child.stdout });
    reader.on('line', line => {
      if (line.length > 4 * 1024 * 1024) { this.fail(new Error('Oversized Codex protocol message.')); return; }
      try { this.receive(JSON.parse(line)); }
      catch { this.fail(new Error('Invalid Codex protocol response.')); }
    });
    // Never log stderr bodies: runtime diagnostics can contain source or account details.
    child.stderr.on('data', () => {});
    child.stdin.on('error', error => this.fail(error));
    child.on('error', error => this.fail(new Error(`Cannot start Codex: ${error.message}`)));
    child.on('exit', (code, signal) => {
      reader.close();
      if (this.child === child) {
        this.fail(new Error(`Codex exited (${code ?? signal}). Check its executable and isolated configuration.`));
      }
    });
    await this.request('initialize', {
      clientInfo: { name: 'vscode_mentor', title: 'Mentor', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    });
    this.send({ method: 'initialized', params: {} });
  }

  private send(message: Wire): void {
    if (!this.child || this.child.killed || !this.child.stdin.writable) { throw new Error('Codex is not running.'); }
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }

  private request(method: string, params: Wire, timeout = 20000): Promise<Wire> {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex ${method} timed out.`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  private receive(message: Wire): void {
    if (message.method && message.id !== undefined) {
      void this.serverRequest(message);
    } else if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) { return; }
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) { pending.reject(new Error(message.error.message ?? 'Codex request failed.')); }
      else { pending.resolve(message.result ?? {}); }
    } else if (typeof message.method === 'string') {
      for (const listener of this.listeners) { listener(message.method, message.params ?? {}); }
    }
  }

  private async serverRequest(message: Wire): Promise<void> {
    const params = message.params ?? {};
    try {
      if (this.modes.get(params.threadId) === 'ask' && this.options.approve) {
        const result = await this.options.approve(message.method, params);
        if (this.modes.get(params.threadId) !== 'ask') { throw new Cancelled(); }
        this.send({ id: message.id, result });
      } else if (message.method.endsWith('/requestApproval')) {
        this.send({ id: message.id, result: { decision: 'decline' } });
      } else {
        this.send({ id: message.id, error: { code: -32601, message: 'This action is unavailable in Mentor.' } });
      }
    } catch {
      try { this.send({ id: message.id, error: { code: -32603, message: 'Request cancelled.' } }); } catch { /* closed */ }
    }
  }

  private fail(error: Error): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    for (const listener of this.listeners) { listener('mentor/error', { message: error.message }); }
    const child = this.child;
    this.child = undefined;
    this.ready = undefined;
    this.modelCache = undefined;
    child?.kill();
  }

  async models(): Promise<Model[]> {
    await this.start();
    if (!this.modelCache) {
      const result = await this.request('model/list', { limit: 100 });
      if (!Array.isArray(result.data) || !result.data.length) { throw new Error('No Codex models available. Sign in with the isolated Codex CLI.'); }
      this.modelCache = result.data.filter((model: Wire) => !model.hidden);
    }
    return this.modelCache!;
  }

  async run(options: RunOptions): Promise<{ text: string; threadId: string; elapsedMs: number }> {
    // The deadline includes startup, model discovery, and thread creation, not just generation.
    const controller = new AbortController();
    let rejectStop!: (error: Error) => void;
    const stopped = new Promise<never>((_resolve, reject) => { rejectStop = reject; });
    const stop = (error: Error) => { controller.abort(); rejectStop(error); };
    const abort = () => stop(new Cancelled());
    options.signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => stop(new Error('Codex response timed out.')), options.timeoutMs);
    if (options.signal.aborted) { abort(); }
    try {
      return await Promise.race([this.runTurn({ ...options, signal: controller.signal }), stopped]);
    } finally {
      clearTimeout(timer);
      options.signal.removeEventListener('abort', abort);
    }
  }

  private async runTurn(options: RunOptions): Promise<{ text: string; threadId: string; elapsedMs: number }> {
    const started = performance.now();
    const check = () => { if (options.signal.aborted) { throw new Cancelled(); } };
    check();
    const models = await this.models();
    check();
    const model = options.model ? models.find(m => m.model === options.model || m.id === options.model)
      : models.find(m => m.isDefault) ?? models[0];
    if (!model) { throw new Error('Configured model is unavailable. Run Mentor: Select Model.'); }
    const effort = model.supportedReasoningEfforts.some(e => e.reasoningEffort === options.effort)
      ? options.effort : model.defaultReasoningEffort;
    let threadId = options.threadId;
    if (threadId) {
      await this.request('thread/resume', { threadId, cwd: options.cwd, model: model.model,
        approvalPolicy: 'on-request', sandbox: 'workspace-write' });
      check();
    }
    if (!threadId) {
      const result = await this.request('thread/start', {
        cwd: options.cwd, model: model.model, approvalPolicy: options.mode === 'ask' ? 'on-request' : 'never',
        sandbox: options.mode === 'ask' ? 'workspace-write' : 'read-only',
        ephemeral: options.mode !== 'ask',
        ...(options.mode !== 'ask' ? {
          baseInstructions: 'You provide bounded coding assistance. All context is in the user message. Do not call tools. Return the requested JSON only.',
          config: { 'features.shell_tool': false, 'features.unified_exec': false,
            'features.multi_agent': false, web_search: 'disabled' },
        } : {}),
      });
      if (typeof result.thread?.id !== 'string') { throw new Error('Codex did not return a thread.'); }
      threadId = result.thread.id;
    }
    const id = threadId!;
    this.modes.set(id, options.mode);
    let turnId: string | undefined;
    let text = '';
    let rejectTurn!: (error: Error) => void;
    let resolveTurn!: () => void;
    const done = new Promise<void>((resolve, reject) => { resolveTurn = resolve; rejectTurn = reject; });
    // An abort/completion can race turn/start's response; attach rejection handling immediately.
    void done.catch(() => {});
    const interrupt = () => {
      if (turnId) { void this.request('turn/interrupt', { threadId: id, turnId }, 5000).catch(() => {}); }
    };
    const abort = () => { interrupt(); rejectTurn(new Cancelled()); };
    const listener = (method: string, params: Wire) => {
      if (method === 'mentor/error') { rejectTurn(new Error(params.message)); return; }
      if (params.threadId !== id) { return; }
      if (method === 'turn/started') { turnId = params.turn?.id; if (options.signal.aborted) { interrupt(); } }
      if (method === 'item/agentMessage/delta') { options.onText?.(params.delta ?? ''); }
      if (method === 'item/completed' && params.item?.type === 'agentMessage') {
        // Completion events contain the final text, avoiding delta duplication and partial JSON.
        if (params.item.phase !== 'commentary') { text = params.item.text; }
      }
      if (method === 'turn/completed') {
        if (params.turn?.status === 'completed') { resolveTurn(); }
        else if (params.turn?.status === 'interrupted') { rejectTurn(new Cancelled()); }
        else { rejectTurn(new Error(params.turn?.error?.message ?? 'Codex turn failed.')); }
      }
    };
    this.listeners.add(listener);
    options.signal.addEventListener('abort', abort, { once: true });
    try {
      check();
      const result = await this.request('turn/start', {
        threadId: id, input: [{ type: 'text', text: options.prompt, text_elements: [] }],
        effort, ...(options.schema ? { outputSchema: options.schema } : {}),
      });
      turnId = result.turn?.id ?? turnId;
      if (options.signal.aborted) { abort(); }
      await done;
      check();
      if (typeof text !== 'string' || !text) { throw new Error('Codex completed without a response.'); }
      const elapsedMs = Math.round(performance.now() - started);
      this.options.log?.(`${options.mode}: ${elapsedMs} ms (${model.model})`);
      return { text, threadId: id, elapsedMs };
    } finally {
      options.signal.removeEventListener('abort', abort);
      this.listeners.delete(listener);
      this.modes.delete(id);
      if (options.mode !== 'ask') { void this.request('thread/unsubscribe', { threadId: id }, 5000).catch(() => {}); }
    }
  }

  dispose(): void { this.fail(new Cancelled()); }
}
