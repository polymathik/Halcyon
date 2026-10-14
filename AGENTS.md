# Halcyon agent guide

## Purpose and current state

Halcyon is a local-first web dashboard for an individual developer's AI coding CLI sessions. It discovers existing sessions, shows them as cards on a spatial canvas, and helps the user organize, inspect, and resume them without replacing the native CLIs.

The repository is pre-implementation. The product draft and working MVP checklist are in `_docs/`, which Git ignores. Read them for product context, but treat this file and the user's current request as the working instructions. The product draft is conceptual; resolve gaps with evidence and record material decisions in `_docs/`.

## MVP boundary

Build for top-level local **Claude Code** and **Codex CLI** sessions first. The MVP includes:

- A CLI command that starts a localhost server and opens the browser.
- Automatic discovery and normalized metadata for the two providers.
- A responsive canvas with session cards, pan, zoom, drag, and persistent positions.
- A non-blocking details sidebar with metadata, a bounded recent-message preview, and native actions.
- Exclusive zones, multiple tags per session, filtering/highlighting, and one persistent default workspace.
- Resume session, open project folder, and copy resume command.
- Useful empty states, adapter failure states, and no required account or API key.

Keep oversight agent/MCP, prompt injection, additional providers, rich live status, multiple named workspaces, cloud sync, multi-user features, and cost analytics outside the MVP unless the user changes scope.

## Implementation direction

- Planned stack: Node.js and TypeScript for the CLI/server, SvelteKit for the UI, and local SQLite for user organization and metadata cache. Keep the adapter contract independent of the UI.
- Separate provider-owned session metadata from user-owned tags and layout. Card position and zone assignment belong to a workspace; a session may be in at most one zone within that workspace.
- Use provider-scoped IDs such as `claude:<id>` and `codex:<id>`. Treat provider indexes as optional hints: the Phase 0 inspection found stale or incomplete indexes for both providers. Enumerate actual session files, stream JSONL, tolerate incomplete trailing lines, and cache parsed metadata so large transcripts are not repeatedly scanned.
- Let adapters fail independently. Distinguish “provider unavailable” or “scan failed” from “no sessions found.”
- Do not infer `working`, `waiting`, or `error` from a recent file write or a stale turn record. Show last activity or `unknown` until a live signal is verified.
- Scope Codex discovery to top-level local CLI sessions for the MVP. IDE/desktop chats, remote chats, and subagents need separate resume semantics.

- UI follows the Halcyon design system (https://claude.ai/code/artifact/ba7edb57-8997-44d1-87e7-812b27d7bb02). Its tokens and `hc-*` component styles are vendored in `apps/web/src/lib/design/`; regenerate `tokens.css` with `pnpm --filter web tokens` and re-vendor rather than editing them. Use tokens and `hc-*` classes, not ad-hoc colours or sizes. Self-host fonts; no CDN requests.

## Privacy and actions

- Keep data local. Bind the server to localhost, add no telemetry by default, and require no cloud service for core features.
- Session transcripts can contain secrets. Parse only the fields needed for list views; do not log raw records, prompts, tool output, or credentials. Load a bounded preview only when requested, and do not persist transcript text in Halcyon's database.
- Validate session IDs and working directories before native actions. Launch processes with executable plus argument arrays, never interpolated shell commands. Quote paths only when displaying a copyable command.
- Confirm provider resume behavior on safe test sessions before promising one-click resume. In Phase 0, Codex CLI execution could not be validated locally. Native actions live in `packages/server/src/actions/native.ts`; tests inject a fake launcher and must never start real processes.

## Working conventions

- Put every document or note created during ideation in `_docs/`; that folder must remain Git-ignored. This requested root `AGENTS.md` is the exception. Keep implementation source, tests, and configuration in their normal tracked locations.
- At the start of every work session, read `_docs/Implementation-Tracker.md` and `_docs/MVP-Plan.md` before choosing work. Use the tracker as the handoff record: check the current phase, completed work, next action, open decisions, blockers, and verification already done. Inspect the repository to confirm the tracker still matches reality.
- Update `_docs/Implementation-Tracker.md` after each meaningful milestone and before ending a session. Record what changed, relevant file paths, checks and results, decisions, remaining risks, and the exact next step. Mark checklist items in `_docs/MVP-Plan.md` only when their acceptance gate is actually met. Never put secrets or transcript content in either file. If agents work in parallel, the primary integrator updates the shared tracker after collecting their results to avoid conflicting edits.
- Follow the phase checklist in `_docs/MVP-Plan.md`. Keep changes small enough to verify against a real user flow. When work can proceed independently, divide by provider adapter, UI, or persistence with clear file ownership, then integrate against the shared contract.
- Use redacted fixtures for parser tests. Test malformed/partial JSONL, missing directories, stale indexes, duplicate IDs, and adapter failure. Avoid tests that only mirror implementation details.
- Before declaring MVP complete, verify install and launch, discovery of both providers, organization surviving restart, and resuming a real supported session.

## Local reference notes

- `_docs/Halcyon-Product-Design.md` — original product design draft.
- `_docs/Halcyon-UI-Design.md` — UI concepts, v0.2 aligned with the design system.
- `_docs/MVP-Plan.md` — phases and acceptance gates.
- `_docs/Implementation-Tracker.md` — current state and next-session handoff; read and update every session.
- `_docs/Claude-Adapter-Discovery.md` and `_docs/Codex-Adapter-Discovery.md` — Phase 0 evidence and open risks.
