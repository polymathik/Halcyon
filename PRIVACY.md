# Privacy

Halcyon is local software. It has no servers, no accounts and no telemetry. Nothing you do in Halcyon is sent anywhere.

## What Halcyon reads

To show your sessions, Halcyon reads the files that supported coding agents already keep in your home folder (for example `~/.claude/projects` or `~/.codex/sessions`; the [README](README.md#supported-agents) lists every location). It reads only what a card needs:

- the session's ID, working folder, start and last-activity times;
- the number of messages you sent;
- a title, but only when the agent itself stored one (a name you gave it, or one the agent generated). Halcyon never uses your prompt text as a title.
- the git branch the agent recorded for the session, when it records one (Claude Code and Codex CLI do).

If a session's folder is inside a git repository, Halcyon reads that repository's `.git/HEAD` and `.git/config` to show the repository name, its `origin` remote and the current branch. It does not run `git`. Usernames, passwords and tokens in remote URLs are removed before the address is shown, and repository details are not stored in Halcyon's database.

For live status it lists running processes by name and, for some agents, checks which session files those processes have open. It does not read their memory, arguments or environment.

When you open a session's details, Halcyon reads a **bounded preview** of the most recent messages from the agent's file, shows it, and discards it. That text is never written to disk by Halcyon.

## What Halcyon stores

One SQLite database in `~/.halcyon/` (or `$HALCYON_HOME`, or `--data-dir`), in a folder only your user can open:

- a cache of the metadata listed above, so large transcripts aren't re-read on every start;
- your organisation: workspaces, zones, card positions, tags, custom titles and archived sessions.

Your browser keeps a few interface preferences (theme, last workspace, toggles) in `localStorage` for `127.0.0.1`.

Halcyon never modifies, moves or deletes an agent's files. Archiving a session only hides it in Halcyon.

## What leaves your machine

Nothing, unless you do it yourself:

- **Export** writes a JSON file of one workspace's layout: zone names and project folders, card positions, tags, custom titles and session IDs. No transcript text. Review it before sharing.
- **Copy command** puts a resume command on your clipboard.
- **Resume** opens your terminal and starts the agent, which then behaves as it normally does, including any network use of its own.

Halcyon makes no network requests: fonts and all assets are bundled, and the server only listens on `127.0.0.1`.

## Removing Halcyon's data

Quit Halcyon and delete `~/.halcyon/` (or the folder you chose). Your agents' sessions are untouched.

## Questions

Open an issue, or use the private channel in [SECURITY.md](SECURITY.md) if the question involves a possible leak.
