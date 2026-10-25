# Working in VS Code Mentor

Read README.md and docs/portability.md before changing launch behavior.

- Keep the four actions deliberate. Do not add automatic model requests or unsolicited UI help text.
- Keep project context bounded and workspace-local. Never apply a stale proposal.
- Keep the launcher Python 3.11+ standard-library-only. No venv or pip bootstrap.
- Preserve isolation from normal VS Code settings, extensions and global Codex configuration.
- Keep exact dependency pins. Do not commit node_modules, dist, .local, VSIX files, credentials or local logs.
- Run Python and Node tests for relevant changes; run the real editor host for UI changes and a live Codex smoke for transport changes.
- Record actual platforms tested and distinguish fixtures from real runtime evidence in docs/verification.md.
- Never publish or push unless the user asks.

Commands: `python3 -S -m unittest discover -s scripts -p 'test_*.py'`, `npm test`, `python3 editor.py test`.
Use `python` on Windows when appropriate. This is an editor tool, not a graphics application or a build system.
