import * as vscode from 'vscode';
import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { CodexClient, Cancelled, ClientOptions } from './codex';
import { Mode, Snapshot, codeSchema, nextSchema, parseCode, parseSteps, makePrompt, insideRoot, isCurrent } from './contracts';

interface Capture {
  document: vscode.TextDocument; version: number; range: vscode.Range; position: vscode.Position;
  anchor: vscode.Position;
  root: string; snapshot: Snapshot;
}
interface Proposal { capture: Capture; code: string; before: vscode.Uri; after: vscode.Uri }
const config = () => vscode.workspace.getConfiguration('mentor');

export function activate(context: vscode.ExtensionContext) {
  if (config().get<boolean>('minimalLayout', false) && !context.globalState.get('layoutInitialized')) {
    void vscode.commands.executeCommand('workbench.action.closeSidebar');
    void context.globalState.update('layoutInitialized', true);
  }
  const output = vscode.window.createOutputChannel('Mentor');
  const answers = vscode.window.createOutputChannel('Mentor Ask', 'markdown');
  let client: CodexClient | undefined;
  let active: { controller: AbortController; mode: Mode; capture?: Capture } | undefined;
  let suggestion: { capture: Capture; code: string } | undefined;
  let preview: Proposal | undefined;
  const askThreads = new Map<string, string>();
  const virtual = new Map<string, string>();
  let serial = 0;
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1);
  status.command = 'mentor.cancel';
  const setContext = (key: string, value: boolean) => vscode.commands.executeCommand('setContext', `mentor.${key}`, value);
  const cancel = () => { active?.controller.abort(); suggestion = undefined; void vscode.commands.executeCommand('editor.action.inlineSuggest.hide'); };
  const guard = <T>(work: () => Promise<T>) => async () => {
    try { return await work(); }
    catch (error) {
      if (!(error instanceof Cancelled)) { void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error)); }
    }
  };

  const approve: ClientOptions['approve'] = async (method, params) => {
    if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
      const detail = typeof params.command === 'string' ? params.command : params.reason ?? 'Apply the requested file changes';
      const choice = await vscode.window.showWarningMessage(detail, { modal: true }, 'Allow Once');
      return { decision: choice === 'Allow Once' ? 'accept' : 'decline' };
    }
    if (method === 'item/tool/requestUserInput') {
      const result: Record<string, { answers: string[] }> = {};
      for (const question of params.questions ?? []) {
        const answer = question.options?.length
          ? (await vscode.window.showQuickPick(question.options.map((o: { label: string; description?: string }) => ({ label: o.label, description: o.description })), { title: question.question }) as vscode.QuickPickItem | undefined)?.label
          : await vscode.window.showInputBox({ title: question.question });
        result[question.id] = { answers: answer ? [answer] : [] };
      }
      return { answers: result };
    }
    throw new Error(`Unsupported Codex request: ${method}`);
  };
  const backend = () => {
    if (!client) {
      client = new CodexClient({ command: config().get<string>('codexPath', 'codex'),
        home: config().get<string>('codexHome'), log: text => output.appendLine(text), approve });
    }
    return client;
  };

  function capture(range?: vscode.Range): Capture {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !['file', 'untitled'].includes(editor.document.uri.scheme)) { throw new Error('Open a workspace file first.'); }
    const document = editor.document;
    const folder = vscode.workspace.getWorkspaceFolder(document.uri) ??
      (document.isUntitled ? vscode.workspace.workspaceFolders?.[0] : undefined);
    if (!folder) { throw new Error('Open a workspace folder first.'); }
    const selected = range ?? editor.selection;
    const start = document.offsetAt(selected.start), end = document.offsetAt(selected.end);
    const text = document.getText();
    if (end - start > 32000) { throw new Error('Select a smaller block (maximum 32,000 characters).'); }
    return {
      document, version: document.version, range: selected, position: editor.selection.active,
      anchor: editor.selection.anchor, root: folder.uri.fsPath,
      snapshot: { file: document.isUntitled ? path.basename(document.uri.fsPath) : path.relative(folder.uri.fsPath, document.uri.fsPath), language: document.languageId,
        version: document.version, before: text.slice(Math.max(0, start - 10000), start),
        selected: text.slice(start, end), after: text.slice(end, end + 5000),
        line: selected.start.line + 1, column: selected.start.character + 1,
        diagnostics: vscode.languages.getDiagnostics(document.uri).slice(0, 6).map(d => `${d.range.start.line + 1}: ${d.message}`),
      },
    };
  }

  function current(c: Capture): boolean {
    const editor = vscode.window.activeTextEditor;
    return !!editor && editor.selection.anchor.isEqual(c.anchor) && isCurrent({ uri: c.document.uri.toString(), version: c.version, offset: c.document.offsetAt(c.position) },
      { uri: editor.document.uri.toString(), version: editor.document.version, offset: editor.document.offsetAt(editor.selection.active) });
  }

  async function projectContext(c: Capture): Promise<string> {
    const names = ['AGENTS.md', 'README.md', config().get<string>('lessonFile', 'lesson.md')];
    const relative = c.snapshot.file.replace(/\\/g, '/');
    const directory = path.posix.dirname(relative);
    if (directory !== '.') { names.push(`${directory}/README.md`); }
    const parts: string[] = [];
    for (const name of names) {
      try {
        const filename = insideRoot(c.root, name);
        // Prevent an instruction/lesson symlink from silently pulling in external files.
        const resolved = await realpath(filename);
        insideRoot(c.root, path.relative(c.root, resolved));
        const uri = vscode.Uri.file(filename);
        const open = vscode.workspace.textDocuments.find(doc => doc.uri.toString() === uri.toString());
        const text = open?.getText() ?? Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
        parts.push(`${name}:\n${text.slice(0, 7000)}`);
      } catch { /* Optional context may not exist in a new project. */ }
    }
    return parts.join('\n\n').slice(0, 24000);
  }

  async function run(mode: Mode, c: Capture, question = '') {
    cancel();
    const operation = { controller: new AbortController(), mode, capture: c };
    active = operation;
    await setContext('busy', true);
    status.text = '$(loading~spin) Mentor'; status.show();
    try {
      const project = await projectContext(c);
      if (operation.controller.signal.aborted) { throw new Cancelled(); }
      return await backend().run({ mode, cwd: c.root, prompt: makePrompt(mode, c.snapshot, project, question),
        schema: mode === 'next' ? nextSchema : mode === 'ask' ? undefined : codeSchema,
        signal: operation.controller.signal,
        timeoutMs: config().get<number>(mode === 'suggest' ? 'suggestTimeoutMs' : 'taskTimeoutMs', 15000),
        model: config().get<string>('model'), effort: config().get<string>('effort', 'low'),
        threadId: mode === 'ask' ? askThreads.get(c.root) : undefined,
        onText: mode === 'ask' ? text => answers.append(text) : undefined,
      });
    } finally {
      if (active === operation) { active = undefined; status.hide(); await setContext('busy', false); }
    }
  }

  const suggest = async () => {
    const c = capture();
    if (!c.range.isEmpty) { throw new Error('Place the cursor, or use Finish for a selection.'); }
    const response = await run('suggest', c);
    if (!current(c)) { return; }
    const code = parseCode(response.text, 20);
    if (!code) { return; }
    suggestion = { capture: c, code };
    await vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
  };

  async function closePreview() {
    const old = preview;
    preview = undefined;
    await setContext('preview', false);
    if (old) {
      const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab =>
        tab.input instanceof vscode.TabInputTextDiff && tab.input.modified.toString() === old.after.toString());
      if (tabs.length) { await vscode.window.tabGroups.close(tabs); }
      virtual.delete(old.before.toString()); virtual.delete(old.after.toString());
    }
  }

  async function showPreview(c: Capture, code: string) {
    await closePreview();
    const original = c.document.getText();
    const eolCode = c.document.eol === vscode.EndOfLine.CRLF ? code.replace(/\n/g, '\r\n') : code;
    const result = original.slice(0, c.document.offsetAt(c.range.start)) + eolCode + original.slice(c.document.offsetAt(c.range.end));
    const suffix = `${++serial}/${path.basename(c.document.uri.fsPath)}`;
    const before = vscode.Uri.from({ scheme: 'vscode-mentor', path: `/before/${suffix}` });
    const after = vscode.Uri.from({ scheme: 'vscode-mentor', path: `/after/${suffix}` });
    virtual.set(before.toString(), original); virtual.set(after.toString(), result);
    preview = { capture: c, code: eolCode, before, after };
    await setContext('preview', true);
    await vscode.commands.executeCommand('vscode.diff', before, after, 'Mentor: Finish', { preview: true });
  }

  const finish = async () => {
    let c = capture();
    if (c.range.isEmpty) {
      const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>('vscode.executeDocumentSymbolProvider', c.document.uri) ?? [];
      const candidates: vscode.DocumentSymbol[] = [];
      const walk = (items: vscode.DocumentSymbol[]) => {
        for (const item of items) {
          if (item.range?.contains(c.position) && [vscode.SymbolKind.Function, vscode.SymbolKind.Method, vscode.SymbolKind.Constructor].includes(item.kind)) { candidates.push(item); }
          if (item.children) { walk(item.children); }
        }
      };
      walk(symbols);
      candidates.sort((a, b) => c.document.offsetAt(a.range.end) - c.document.offsetAt(a.range.start) - (c.document.offsetAt(b.range.end) - c.document.offsetAt(b.range.start)));
      if (!candidates.length) { throw new Error('Select the block to finish.'); }
      if (!current(c)) { return; }
      c = capture(candidates[0].range);
    }
    const response = await run('finish', c);
    if (!current(c)) { return; }
    const code = parseCode(response.text);
    if (code) { await showPreview(c, code); }
  };

  const accept = async () => {
    const proposal = preview;
    if (!proposal) { return; }
    const c = proposal.capture;
    if (c.document.isClosed || c.document.version !== c.version) { await closePreview(); throw new Error('File changed. Run Finish again.'); }
    const editor = await vscode.window.showTextDocument(c.document, { preview: false });
    if (c.document.version !== c.version) { throw new Error('File changed. Run Finish again.'); }
    if (!await editor.edit(builder => builder.replace(c.range, proposal.code), { undoStopBefore: true, undoStopAfter: true })) {
      throw new Error('Could not apply the proposal.');
    }
    await closePreview();
  };

  const next = async () => {
    const c = capture();
    const response = await run('next', c);
    if (!current(c)) { return; }
    const steps = parseSteps(response.text, c.root);
    const selected = await vscode.window.showQuickPick(steps.map(step => ({ label: step.title, detail: step.reason,
      description: `${step.file}:${step.line}`, step })), { title: 'Next' });
    if (!selected) { return; }
    const target = insideRoot(c.root, selected.step.file);
    try {
      const resolved = await realpath(target);
      insideRoot(c.root, path.relative(c.root, resolved));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; }
      // Navigation never creates a file on disk. New-file steps open an untitled buffer.
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(target).with({ scheme: 'untitled' }));
      await vscode.window.showTextDocument(document); return;
    }
    const doc = await vscode.workspace.openTextDocument(target);
    const line = Math.min(doc.lineCount - 1, selected.step.line - 1);
    await vscode.window.showTextDocument(doc, { selection: new vscode.Range(line, 0, line, 0) });
  };

  const ask = async (questionOverride?: string) => {
    let c = capture();
    const question = questionOverride ?? await vscode.window.showInputBox({ title: 'Ask Codex', ignoreFocusOut: true });
    if (!question?.trim()) { return; }
    // Ask can run tools against disk. Save only this workspace's dirty files, with explicit consent.
    const dirty = vscode.workspace.textDocuments.filter(doc => doc.isDirty &&
      ((doc.uri.scheme === 'file' && vscode.workspace.getWorkspaceFolder(doc.uri)?.uri.fsPath === c.root) ||
       (doc.isUntitled && doc === c.document)));
    if (dirty.length) {
      if (await vscode.window.showWarningMessage('Ask can edit files and run commands. Save changed workspace files first?', { modal: true }, 'Save and Run') !== 'Save and Run') { return; }
      for (const doc of dirty) { if (!await doc.save()) { throw new Error('Could not save all changed workspace files.'); } }
      c = capture();
    }
    answers.appendLine(`\n> ${question}\n`); answers.show(true);
    const response = await run('ask', c, question);
    askThreads.set(c.root, response.threadId);
    answers.appendLine('\n');
  };

  const commands: Record<string, () => Promise<unknown>> = {
    suggest, finish, next, ask, accept, discard: closePreview,
    cancel: async () => cancel(),
    reset: async () => { cancel(); client?.dispose(); client = undefined; askThreads.clear(); answers.clear(); },
    menu: async () => {
      const picked = await vscode.window.showQuickPick(['Suggest', 'Finish', 'Next', 'Ask'], { title: 'Mentor' });
      if (picked) { await vscode.commands.executeCommand(`mentor.${picked.toLowerCase()}`); }
    },
    model: async () => {
      const models = await backend().models();
      const selected = await vscode.window.showQuickPick(models.map(model => ({ label: model.displayName, description: model.model, model })), { title: 'Codex Model' });
      if (selected) { await config().update('model', selected.model.model, vscode.ConfigurationTarget.Global); askThreads.clear(); }
    },
  };
  for (const [name, command] of Object.entries(commands)) {
    context.subscriptions.push(vscode.commands.registerCommand(`mentor.${name}`, guard(command)));
  }
  const provider: vscode.InlineCompletionItemProvider = {
    provideInlineCompletionItems(document, position) {
      const item = suggestion;
      if (!item || item.capture.document !== document || document.version !== item.capture.version || !position.isEqual(item.capture.position) || !current(item.capture)) { return []; }
      return [new vscode.InlineCompletionItem(item.code, new vscode.Range(position, position), { command: 'mentor.accepted', title: 'Accepted' })];
    },
  };
  context.subscriptions.push(
    output, answers, status,
    vscode.commands.registerCommand('mentor.accepted', () => { suggestion = undefined; }),
    vscode.languages.registerInlineCompletionItemProvider([{ scheme: 'file' }, { scheme: 'untitled' }], provider),
    vscode.workspace.registerTextDocumentContentProvider('vscode-mentor', { provideTextDocumentContent: uri => virtual.get(uri.toString()) ?? '' }),
    vscode.workspace.onDidChangeTextDocument(event => {
      if (event.contentChanges.length && active?.capture?.document === event.document && active.mode !== 'ask') { cancel(); }
      if (suggestion?.capture.document === event.document && event.contentChanges.length) { suggestion = undefined; }
    }),
    vscode.window.onDidChangeTextEditorSelection(() => { if (active?.capture && active.mode !== 'ask' && !current(active.capture)) { cancel(); } }),
    vscode.window.onDidChangeActiveTextEditor(() => { if (active?.capture && active.mode !== 'ask' && !current(active.capture)) { cancel(); } }),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('mentor.codexPath') || event.affectsConfiguration('mentor.codexHome')) { cancel(); client?.dispose(); client = undefined; askThreads.clear(); }
    }),
    { dispose: () => { cancel(); client?.dispose(); } },
  );
  // No test commands or fixture settings are exposed in a normal installed extension.
  if (context.extensionMode === vscode.ExtensionMode.Test) {
    return { provider, capture, suggest, finish, next, ask, accept, closePreview, getPreview: () => preview,
      getSuggestion: () => suggestion, setClient: (value: CodexClient) => { client?.dispose(); client = value; } };
  }
}
