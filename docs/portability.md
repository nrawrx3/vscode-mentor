# Platform support

| Component | Windows | Linux | macOS |
| --- | --- | --- | --- |
| Launcher and VS Code extension | Implemented, native x64 tested | Implemented, native x64 tested | Implemented; native desktop check pending |
| Pinned Codex runtime | x64 / ARM64 | x64 / ARM64 | Intel / Apple Silicon |
| Pinned clangd download | x64 | x64 | Universal Intel + Apple Silicon |
| Other ARM64 clangd | Explicit `--clangd-path` | Explicit `--clangd-path` | Included in the pinned archive |

Python scripts use only the standard library. Node/npm and VS Code are separate prerequisites. No compiler, graphics SDK,
Meson or particular project tree is required to run the editor's tests.

Windows batch shims are resolved to native executable/JavaScript entry points without constructing shell command strings.
macOS app paths, spaces in paths, and per-workspace compilation database locations are supported. Native Codex selection
uses Node's architecture, including an Intel Node under Rosetta. ZIP extraction verifies SHA256, preserves Unix executable
permissions, strips privileged mode bits, and rejects traversal, symlinks and special files.

Private user-data directories are keyed by canonical workspace path, while extension installs and isolated Codex state belong
to this tool checkout. Portable VS Code data directories and VSCODE_PORTABLE are rejected because they override isolation.
Missing/keychain credentials and cross-device hard-link failures use an explicit `editor.py login`, with no token-copy fallback.

The macOS clangd archive's SHA256 and universal Mach-O headers were inspected. Archive inspection does not prove native
execution. ARM64, the macOS editor host, VS Code Remote SSH, WSL, dev containers and browser VS Code remain unverified.
The extension runs on the workspace host and requires local process/filesystem access; it is not a web extension.

This repository was extracted from an NGA learning tool. Projects opened with it retain their own platform limits: an editor
cannot make platform-specific code build or create an accurate compilation database without the project's native build setup.
See [verification](verification.md) for executed checks and their scope.
