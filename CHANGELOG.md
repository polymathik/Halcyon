# Changelog

Notable changes to Halcyon. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/). Until 1.0, minor versions may change behaviour.

## [Unreleased]

### Changed

- The npm package's repository link points to `packages/server` inside the GitHub repository.

## [0.2.0] - 2026-10-17

### Added

- Git details: when a session's folder is in a git repository, the sidebar shows the repository (with a link to its web page), remote, current branch and the branch the session ran on (Claude Code and Codex CLI record it). Zoomed in past 125%, cards show the folder from the repository root and the branch. Halcyon reads `.git` files directly and strips credentials from remote URLs.

## [0.1.0] - 2026-10-15

First public release.

### Added

- Published on npm as `halcyon-ai`: run `npx halcyon-ai`, or `npm install -g halcyon-ai` for the `halcyon` command. The CLI exits with a clear message on Node.js older than 22.17.
- `halcyon` command: starts a server on `127.0.0.1` and opens the browser. Options for port, data folder, no-open and a demo mode with invented sessions.
- Discovery of top-level, resumable sessions for Claude Code, Codex CLI, Cursor CLI, Gemini CLI, Qwen Code, GitHub Copilot CLI, OpenCode, Kilo Code, Crush and Goose. Each agent fails independently and reports "not installed", "scan failed" or "no sessions" separately.
- Canvas: session cards with pan, zoom, drag, multi-select, minimap and persistent positions; level of detail when zoomed out.
- Organisation: zones (exclusive, collapsible, resizable), multiple tags per session, filter by tag (highlight or only), group by project, arrange by tag, custom titles, archive.
- Named workspaces with their own layouts, plus export and import as JSON.
- Details sidebar with metadata, a bounded preview of recent messages and native actions: resume in terminal, open folder, copy resume command.
- Live status from signals the agents publish: working, needs input, idle and open for Claude Code; open for Codex, Qwen Code and Copilot CLI. Card borders show status and fade with inactivity.
- Light and dark themes; Geist and Geist Mono bundled; Horizon mark.
- Apache License 2.0, security and privacy policies, contributing guide.

[Unreleased]: https://github.com/sarupurisailalith/Halcyon/compare/v0.2.0...main
[0.2.0]: https://www.npmjs.com/package/halcyon-ai/v/0.2.0
[0.1.0]: https://www.npmjs.com/package/halcyon-ai/v/0.1.0
