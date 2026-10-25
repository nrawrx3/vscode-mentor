# VS Code Mentor

Four deliberate Codex actions in a minimal VS Code editor: **Suggest, Finish, Next, Ask**.
Built for learning by writing code, with assistance only when requested. The isolated setup installs clangd and this extension.
There are no runtime npm dependencies in the extension and no third-party Python dependencies in the launcher.

## Start

Install Python 3.11+, Node.js 22+ with npm, and VS Code 1.95+. A Codex sign-in is needed for model requests.

```sh
git clone https://github.com/nrawrx3/vscode-mentor.git
cd vscode-mentor
python3 editor.py setup --workspace /path/to/your/project
```

Use `python` on Windows if `python3` is unavailable. The project must be an existing directory. The launcher needs no venv.
It uses the installed VS Code executable; `--code-path` can select a separate installation or a macOS `.app`.
On macOS, `/Applications` and `~/Applications` are checked when `code` is not on PATH.

```sh
python3 editor.py open --workspace /path/to/your/project
python3 editor.py check --workspace /path/to/your/project
python3 editor.py login
```

`--workspace` defaults to the current directory. Setup opens the editor unless `--no-launch` is supplied.
Close this tool's editor windows before reinstalling. On first open, VS Code may ask you to trust the project.
The launcher preserves that check; only automated test windows disable workspace trust.

For accurate C++ navigation, generate the project's `compile_commands.json`. The default location is `<workspace>/build`;
`--build-dir` selects a directory relative to the workspace, or an absolute path. Fallback flags alone cannot supply a project's
headers, compiler settings, or platform dependencies. The extension itself does not depend on a particular build system or graphics API.

## Four actions

| Action | Invocation | Behavior |
| --- | --- | --- |
| Suggest | `Alt+\` | Manual ghost text, at most 20 lines; Tab accepts |
| Finish | Help Here or command palette | Complete the selection or smallest enclosing function reported by the LSP; review the diff |
| Next | Help Here or command palette | Exactly two concrete tasks; choosing one navigates without implementing it |
| Ask | Help Here or command palette | Free-form agent request with tools and a conversation per workspace |

`Ctrl+Alt+Space` opens Help Here. `Ctrl+Enter` (`Cmd+Enter` on macOS) applies a Finish preview; Esc discards it.
Suggest and Finish each apply as one undo step. Editing, moving the cursor, or switching editors cancels an in-flight proposal.
Applying a stale Finish preview fails. Automatic completion events never call the model.

Ask streams into the Mentor Ask output panel. It can edit files on disk and run commands within Codex's workspace-write sandbox.
It asks to save dirty workspace files before starting. Review its changes with Git; they are not one editor undo step.
Codex command/file approval requests appear as native Allow Once dialogs. Unsupported requests fail closed.
Use **Mentor: New Ask Conversation** to reset context, and **Mentor: Select Model** to choose from the account's model catalog.

## Isolation

Mutable state stays in this checkout's ignored `.local/` directory:

- `workspaces/<id>/user-data/`: separate editor settings and UI state for each canonical workspace path.
- `extensions/`: exactly `llvm-vs-code-extensions.vscode-clangd@0.1.33` and the locally packaged `nrawrx3.vscode-mentor`.
- `codex/`: independent Codex config and sessions, with mode 0700 on Unix.
- `clangd/`, `archives/`: checksum-verified clangd download and cache.
- `test-*`, `live-workspace/`: disposable test fixtures and profiles.

The normal VS Code settings and extensions are not edited. Settings Sync is off. Built-in extensions remain part of VS Code.
Portable-mode data directories and `VSCODE_PORTABLE` are rejected because they override the isolation flags.
A shared VS Code executable still receives its normal updates; a separate executable can be selected with `--code-path`.
Repeated setup preserves preferences while refreshing tool paths. Do not copy `.local/` or `node_modules/` between operating systems.

Setup installs Codex CLI **0.164.0** locally and chooses its native package using Node's OS and architecture.
The global CLI is unchanged. `--codex-path` overrides the native executable at setup.
Existing file credentials can be hard-linked from `CODEX_HOME` or `~/.codex` without reading/copying their contents.
This shares the initial sign-in, not a separate account. Atomic refresh can separate the links. For keychain credentials,
missing credentials, cross-filesystem links or an expired isolated sign-in, run `python3 editor.py login`.

clangd **21.1.8** is pinned for Windows x64, Linux x64, and universal Intel/Apple Silicon macOS. Linux/Windows ARM64 require
an installed native clangd supplied through `--clangd-path`. Windows and Linux have native verification; macOS desktop
validation is still pending. See [platform details](docs/portability.md) and [test evidence](docs/verification.md).

## Learning context

Add a `lesson.md` to the project you are editing, or set `mentor.lessonFile` to another workspace-relative file.
[examples/lesson.md](examples/lesson.md) is a starting point. Keep the current objective and student-owned decisions there.

Requests include bounded unsaved code around the cursor/selection, up to six diagnostics, the workspace's AGENTS/README,
the lesson, and a README beside the current file when present. Suggest, Finish and Next do not recursively scan the repository.
They use fresh ephemeral threads with read-only access and shell tools disabled. Ask uses the normal tool-capable harness.
The extension does not attach to the Codex desktop chat or inherit its history.

The client starts `codex app-server` as a persistent local subprocess and exchanges JSON messages over stdin/stdout.
It handles initialization, model discovery, threads, turns, streaming responses, approvals, and cancellation.
Local transport does not mean local inference: request context goes to Codex's configured model provider.
The extension logs operation/model/timing metadata. Codex owns its own local state.

## Development

```sh
python3 -S -m unittest discover -s scripts -p 'test_*.py'
npm ci
npm test
python3 editor.py test
npm run package
```

The Python tests need no editor, Node, sign-in, compiler or external Python packages. Node tests use a deterministic JSONL
subprocess fixture. `editor.py test` creates its own C++ fixture workspace under `.local/` and runs a real VS Code extension host;
it does not use or modify the selected project. A desktop is required; headless Linux can use an installed `xvfb-run`.
CI runs Python/Node tests and VSIX packaging on Windows, Linux and macOS.

After setup and sign-in, `npm run smoke:codex -- --all-actions` checks real model requests plus a temporary Ask file write
and conversation resume in `.local/live-workspace`. It makes model requests and removes its marker afterwards.
Smoke timings are connectivity evidence, not a latency distribution or teaching-quality benchmark.

Codex, TypeScript, VS Code/Node types and VSCE are exact dependency pins; the lockfile records the transitive tree.
The VSIX is built locally. This repository does not publish an extension to the Marketplace.
App-server is experimental; repeat transport, editor-host and live checks when updating Codex.
The package retains its original `UNLICENSED` status.

Sources: [VS Code command line](https://code.visualstudio.com/docs/configure/command-line),
[portable mode](https://code.visualstudio.com/docs/setup/portable),
[inline completion API](https://code.visualstudio.com/api/language-extensions/programmatic-language-features),
[clangd releases](https://github.com/clangd/clangd/releases/tag/21.1.8),
[Codex app-server](https://learn.chatgpt.com/docs/app-server).
