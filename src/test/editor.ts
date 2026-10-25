import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import path from 'node:path';
import { CodexClient, Cancelled } from '../codex';

async function runTests() {
  await vscode.workspace.getConfiguration('chat').update('disableAIFeatures', true, vscode.ConfigurationTarget.Global);
  const extension = vscode.extensions.getExtension('nrawrx3.vscode-mentor');
  assert.ok(extension);
  const api = await extension.activate();
  api.setClient(new CodexClient({ command: process.execPath, args: [path.join(__dirname, 'fake-server.js')] }));
  const root = vscode.workspace.workspaceFolders![0].uri;
  const uri = vscode.Uri.joinPath(root, 'editor fixture #1.cpp');
  await vscode.workspace.fs.writeFile(uri, Buffer.from('int answer() {\n    \n}\n'));
  const doc = await vscode.workspace.openTextDocument(uri);
  let editor = await vscode.window.showTextDocument(doc);
  const position = new vscode.Position(1, 4);
  editor.selection = new vscode.Selection(position, position);
  await editor.edit(edit => edit.insert(position, ' '));
  editor.selection = new vscode.Selection(1, 5, 1, 5);
  assert.equal(doc.isDirty, true, 'fixture must exercise unsaved text');
  await api.suggest();
  const items = api.provider.provideInlineCompletionItems(doc, editor.selection.active);
  assert.equal(items.length, 1);
  assert.equal(items[0].insertText, 'return 42;');
  await vscode.commands.executeCommand('editor.action.inlineSuggest.commit');
  assert.match(doc.getText(), /return 42;/, 'native Tab action inserts the actual ghost text');
  await vscode.commands.executeCommand('undo');
  assert.doesNotMatch(doc.getText(), /return 42;/, 'one undo removes the accepted suggestion');

  editor.selection = new vscode.Selection(new vscode.Position(0, 0), doc.positionAt(doc.getText().length));
  const before = doc.getText();
  await api.finish();
  assert.ok(api.getPreview());
  assert.ok(api.getPreview().after.path.endsWith('editor fixture #1.cpp'));
  assert.equal(api.getPreview().after.fragment, '', 'file name must not become a URI fragment');
  assert.equal(doc.getText(), before, 'preview does not edit the document');
  await api.accept();
  assert.equal(doc.getText(), 'int answer() { return 42; }');
  await vscode.commands.executeCommand('undo');
  assert.equal(doc.getText(), before, 'Finish is a single undo step');

  editor = await vscode.window.showTextDocument(doc);
  editor.selection = new vscode.Selection(0, 0, doc.lineCount - 1, 0);
  await api.finish();
  editor = await vscode.window.showTextDocument(doc);
  await editor.edit(edit => edit.insert(new vscode.Position(0, 0), '// changed\n'));
  await assert.rejects(api.accept(), /File changed/);
  assert.match(doc.getText(), /changed/, 'stale preview preserves newer edits');

  editor.selection = new vscode.Selection(0, 0, 0, 0);
  await editor.edit(edit => edit.insert(new vscode.Position(0, 0), '// DELAY_FIXTURE\n'));
  editor.selection = new vscode.Selection(1, 0, 1, 0);
  const pending = api.suggest();
  await new Promise(resolve => setTimeout(resolve, 100));
  await editor.edit(edit => edit.insert(new vscode.Position(1, 0), '// user typing\n'));
  await assert.rejects(pending, Cancelled);
  assert.equal(api.getSuggestion(), undefined, 'typing cancels the in-flight proposal');
  await editor.edit(edit => edit.replace(new vscode.Range(0, 0, doc.lineCount - 1, 0), 'int answer();\n'));
  await doc.save();
  await api.ask('Explain this declaration without editing it.');
  await api.ask('Give a shorter explanation.');
  assert.equal(doc.isDirty, false, 'Ask fixture does not change the buffer');

  editor = await vscode.window.showTextDocument(doc);
  const navigation = api.next();
  await new Promise(resolve => setTimeout(resolve, 300));
  await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
  await Promise.race([navigation, new Promise((_resolve, reject) => setTimeout(() => reject(new Error('Next picker did not finish')), 3000))]);
  assert.equal(vscode.window.activeTextEditor?.document.uri.fsPath, vscode.Uri.joinPath(root, 'src/app.cpp').fsPath);
  assert.equal(vscode.window.activeTextEditor?.document.isDirty, false, 'Next only navigates');
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await vscode.workspace.fs.delete(uri);
  console.log('Mentor editor integration passed: Suggest, Finish, Next, Ask, cancellation, stale rejection, undo.');
}

export async function run() {
  const extension = vscode.extensions.getExtension('nrawrx3.vscode-mentor');
  assert.ok(extension);
  const result = vscode.Uri.joinPath(extension.extensionUri, '.local/editor-test-result.json');
  try {
    await runTests();
    await vscode.workspace.fs.writeFile(result, Buffer.from(JSON.stringify({ passed: true })));
  } catch (error) {
    await vscode.workspace.fs.writeFile(result, Buffer.from(JSON.stringify({ passed: false, message: String(error) })));
    throw error;
  }
}
