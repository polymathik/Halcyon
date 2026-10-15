# Changelog

Notable changes to Halcyon. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/). Until 1.0, minor versions may change behaviour.

## [Unreleased]

First public release candidate.

### Added

- `halcyon` command: starts a server on `127.0.0.1` and opens the browser. Options for port, data folder, no-open and a demo mode with invented sessions.
- Discovery of top-level, resumable sessions for Claude Code, Codex CLI, Cursor CLI, Gemini CLI, Qwen Code, GitHub Copilot CLI, OpenCode, Kilo Code, Crush and Goose. Each agent fails independently and reports "not installed", "scan failed" or "no sessions" separately.
- Canvas: session cards with pan, zoom, drag, multi-select, minimap and persistent positions; level of detail when zoomed out.
- Organisation: zones (exclusive, collapsible, resizable), multiple tags per session, filter by tag (highlight or only), group by project, arrange by tag, custom titles, archive.
- Named workspaces with their own layouts, plus export and import as JSON.
- Details sidebar with metadata, a bounded preview of recent messages and native actions: resume in terminal, open folder, copy resume command.
- Live status from signals the agents publish: working, needs input, idle and open for Claude Code; open for Codex, Qwen Code and Copilot CLI. Card borders show status and fade with inactivity.
- Light and dark themes; Geist and Geist Mono bundled; Horizon mark.
- Apache License 2.0, security and privacy policies, contributing guide.

[Unreleased]: https://github.com/sarupurisailalith/Halcyon/commits/main
