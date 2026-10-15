# Halcyon agent guide

Instructions for AI coding agents (and people) working in this repository. Human contributors should also read [CONTRIBUTING.md](CONTRIBUTING.md).

## Purpose and scope

Halcyon is a local-first web dashboard for an individual developer's AI coding CLI sessions. It discovers existing sessions, shows them as cards on a spatial canvas, and helps the user organize, inspect, and resume them without replacing the native CLIs.

It currently covers top-level, resumable local sessions for Claude Code, Codex CLI, Cursor CLI, Gemini CLI, Qwen Code, GitHub Copilot CLI, OpenCode, Kilo Code, Crush and Goose (one adapter per agent in `packages/server/src/adapters/<provider>/`), plus named workspaces, export/import, zones, tags, filtering, live status from provider signals, and native actions (resume, open folder, copy resume command).

Keep an oversight agent/MCP, prompt injection into sessions, cloud sync, multi-user features and cost analytics out unless the maintainer asks for them.

## Implementation direction

- Stack: Node.js and TypeScript for the CLI/server (`packages/server`, Hono, `node:sqlite`), shared contracts in `packages/core`, SvelteKit for the UI (`apps/web`), and local SQLite for user organization and the metadata cache. Keep the adapter contract independent of the UI.
- Separate provider-owned session metadata from user-owned tags and layout. Card position and zone assignment belong to a workspace; a session may be in at most one zone within that workspace.
- Use provider-scoped IDs such as `claude:<id>` and `codex:<id>`, with a native-ID rule per provider in `packages/core/src/ids.ts`. Treat provider indexes as optional hints: they are often stale or incomplete. Enumerate actual session files, stream JSONL, tolerate incomplete trailing lines, and cache parsed metadata so large transcripts are not repeatedly scanned.
- Let adapters fail independently. Distinguish “provider unavailable” or “scan failed” from “no sessions found.”
- Do not infer `working`, `waiting`, or `error` from a recent file write or a stale turn record. Show last activity or `unknown` until a live signal the provider publishes is verified.
- List only top-level local CLI sessions. IDE/desktop chats, remote chats, and subagents need separate resume semantics.
- UI follows the Halcyon design system. Its tokens and `hc-*` component styles are vendored in `apps/web/src/lib/design/` and are the source of truth in this repository; regenerate `tokens.css` with `pnpm --filter web tokens` rather than editing it. The upstream design system is a private artifact the maintainer re-vendors from; if you need a design-system change, describe it in the pull request. Use tokens and `hc-*` classes, not ad-hoc colours or sizes. Self-host fonts; no CDN requests.

## Privacy and actions

- Keep data local. Bind the server to localhost, add no telemetry by default, and require no cloud service for core features.
- Session transcripts can contain secrets. Parse only the fields needed for list views; do not log raw records, prompts, tool output, or credentials. Load a bounded preview only when requested, and do not persist transcript text in Halcyon's database. Keep [PRIVACY.md](PRIVACY.md) and [SECURITY.md](SECURITY.md) accurate when behaviour changes.
- Validate session IDs and working directories before native actions. Launch processes with executable plus argument arrays, never interpolated shell commands. Quote paths only when displaying a copyable command.
- Confirm provider resume behavior on safe test sessions before promising one-click resume. Native actions live in `packages/server/src/actions/native.ts`; tests inject a fake launcher and must never start real processes.
- Never read, copy or commit real session files. Use invented fixtures with the same structure.

## Working conventions

- Follow the commands in CONTRIBUTING.md: `pnpm build`, `pnpm typecheck`, `pnpm test`. Use `--fixtures` for UI work and screenshots.
- Keep changes small enough to verify against a real user flow. When work can proceed independently, divide by provider adapter, UI, or persistence with clear file ownership, then integrate against the shared contract.
- Use invented, redacted fixtures for parser tests. Test malformed/partial JSONL, missing directories, stale indexes, duplicate IDs, and adapter failure. Avoid tests that only mirror implementation details.
- Add user-visible changes to `CHANGELOG.md` under Unreleased. Re-run `pnpm notices` when a bundled runtime dependency changes.

## Maintainer's local notes

The maintainer keeps planning notes in a Git-ignored `_docs/` folder; it is not part of a clone. If `_docs/` exists in your workspace:

- Put every document or note created during ideation or planning in `_docs/`; it must stay Git-ignored. Keep implementation source, tests, and configuration in their normal tracked locations.
- At the start of every work session, read `_docs/Implementation-Tracker.md` and `_docs/MVP-Plan.md` before choosing work, and inspect the repository to confirm the tracker still matches reality.
- Update `_docs/Implementation-Tracker.md` after each meaningful milestone and before ending a session: what changed, relevant file paths, checks and results, decisions, remaining risks, and the exact next step. Never put secrets or transcript content in it. If agents work in parallel, the primary integrator updates the shared tracker after collecting their results.
- Other notes there: `Halcyon-Product-Design.md` (product draft), `Halcyon-UI-Design.md` (UI concepts), `Decisions.md`, and the Claude and Codex adapter discovery notes.
