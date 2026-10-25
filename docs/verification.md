# Standalone extraction verification — 2026-10-26

The editor was extracted from an NGA learning workspace into this independent repository. The launcher accepts an external
workspace, stores editor preferences per canonical workspace path, and supplies its own test fixtures. No NGA source tree,
graphics dependencies, Meson or C++ compiler is required for these editor checks.

## Executed platforms

| | Windows x64 | Linux x64 |
| --- | --- | --- |
| OS | Windows | Nobara 44, KDE/Wayland, Linux 7.2.11 |
| Python | 3.12 | 3.14.7 |
| Node | 25.8.2 | 22.22.2 |
| VS Code | 1.143.1 | 1.143.1 |
| Pinned Codex / clangd | 0.164.0 / 21.1.8 | 0.164.0 / 21.1.8 |

On both platforms:

- `python3 -S -m unittest discover -s scripts -p 'test_*.py'`: **13/13 passed**, with site packages disabled.
  Checks ZIP safety/permissions, architecture selection, Windows CLI shims, macOS app discovery, portable-mode rejection,
  cross-device credential-link failure, isolated workspace profiles, preference preservation and literal subprocess arguments.
- `python3 editor.py setup --workspace <external-project> --no-launch`: passed. Exactly clangd extension 0.1.33 and
  `nrawrx3.vscode-mentor` 0.1.0 were installed in private extension directories. The selected project was outside this checkout.
- `python3 editor.py check --workspace <external-project>`: passed. Native clangd and Codex executed. Linux correctly reported
  the test project's missing compilation database; the editor does not conceal that project limitation.
- `python3 editor.py test`: **9/9 Node tests and the real VS Code extension-host test passed**. Its synthetic C++ workspace
  is under `.local/`. Covers manual ghost-text acceptance, single undo, Finish diff/apply, filename spaces and `#`, stale preview
  rejection, typing cancellation, Next navigation and Ask fixture requests.
- `node dist/test/live.js --all-actions`: real Suggest, Finish, Next, Ask file writing, and Ask conversation resume passed.
  The test verifies the temporary marker's actual contents and removes it. It uses `.local/live-workspace`, not project files.
- VSIX packaging passed. Normal VS Code settings hashes and extension/version lists matched their recorded baselines.

The Linux host test used the active desktop's connection variables through SSH. It did not use `--no-sandbox` and does not
test the VS Code Remote SSH extension. Existing file credentials were reused locally on each host; no credentials moved
between machines. Use `python` instead of `python3` for the commands on Windows when needed.

## Live smoke samples

All times below are full responses in milliseconds using the account-default `gpt-6.1-sol` at low effort.

| Action | Windows | Linux |
| --- | --- | --- |
| Suggest, three requests | 3386, 2507, 2829 | 3117, 2538, 1926 |
| Finish | 2842 | 4800 |
| Next | 4619 | 4991 |
| Ask write | 7444 | 5298 |
| Ask resume | 1989 | 2582 |

These tiny smoke samples establish connectivity and basic behavior, not p50/p95 latency, teaching quality or an instant
autocomplete experience. No student usability study has been performed.

## Remaining checks

Native macOS editor-host, ARM64 runtime, manual approval-dialog usability, Remote SSH, WSL, dev containers and browser
VS Code remain unverified. CI covers Python/Node tests and packaging on Windows, Linux and macOS; native GUI and authenticated
model tests are separate. The next platform check is the real macOS editor host and live Codex smoke.
