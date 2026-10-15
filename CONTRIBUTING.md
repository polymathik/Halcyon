# Contributing to Halcyon

Thanks for your interest. Halcyon is a small project with one maintainer, so focused issues and small pull requests get the quickest response.

## Ways to help

- **Report a bug** with the bug template. Include your OS, Node.js version, the agent and its version, and what Halcyon showed.
- **Report an agent that misbehaves.** Most adapters were built against undocumented formats and haven't seen many real sessions yet. The agent-support template asks for the details we need, never the transcript itself.
- **Request a new agent** with the agent-support template, including where it stores sessions and how it resumes one.
- **Send a pull request** for a fix or a feature discussed in an issue first.

Security problems go through [SECURITY.md](SECURITY.md), not public issues.

## Never share real transcripts

Session files contain your prompts, code, tool output and sometimes credentials. Do not attach them to issues, paste them into pull requests or commit them as fixtures. When a parser needs a test case, write an invented one that has the same structure: made-up IDs, paths such as `/Users/demo/project`, and placeholder text.

## Development setup

You need Node.js 22.17 or later and pnpm 10 (`corepack enable` gives you the pinned version).

```sh
pnpm install
pnpm build          # core, server and web, then bundles the UI into the server
pnpm test           # Vitest across all packages
pnpm typecheck      # tsc and svelte-check
node packages/server/dist/cli.js --no-open --fixtures   # demo data on :4317
pnpm --filter web dev                                   # UI dev server, proxies /api to :4317
```

`--fixtures` runs with invented sessions and never starts a real process, so it is safe for screenshots and UI work.

## Pull request checklist

- `pnpm typecheck` and `pnpm test` pass.
- New behaviour has tests. Parser tests cover malformed and truncated input, a missing store and duplicate IDs. Tests never start real processes: native actions take an injected fake launcher.
- UI changes use the design-system tokens and `hc-*` classes from `apps/web/src/lib/design/` rather than one-off colours or sizes, and work in light and dark themes. Include a before/after screenshot taken with `--fixtures`.
- No new network requests, telemetry or CDN assets. Fonts and assets are bundled.
- No transcript text is logged or written to Halcyon's database.
- Processes are started with an executable and an argument array, never a shell string.

## Adding an agent

1. Add the provider ID to `PROVIDERS` and its native-ID rule in `packages/core/src/` (`session.ts`, `ids.ts`).
2. Create `packages/server/src/adapters/<agent>/` implementing `ProviderAdapter`: `detect`, `scan` (top-level, resumable sessions only), `resumeCommand` (argv, not a string), and optionally `preview` and `live`.
3. Register it in `packages/server/src/adapters/index.ts` and give it a label and monogram in `apps/web/src/lib/format.ts`.
4. Add tests with invented fixtures, and a row to the README's supported-agents table.

Report live status only from a signal the agent publishes itself (a session registry or a lock held by its process). Never infer *working* or *waiting* from a recent file write; leave the status unknown instead.

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). By taking part you agree to it.

## Licence

Halcyon is licensed under the [Apache License 2.0](LICENSE). Unless you say otherwise, any contribution you submit is licensed under the same terms, as described in section 5 of the licence. You keep the copyright to your contribution.
