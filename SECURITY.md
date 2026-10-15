# Security policy

Halcyon reads the session files of AI coding agents on your machine, and those transcripts can contain source code, credentials and other secrets. We take reports seriously and would rather hear about a possible problem early than late.

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

Report it privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability** ([direct link](https://github.com/sarupurisailalith/Halcyon/security/advisories/new)). Include:

- the Halcyon version or commit, your OS and Node.js version;
- what an attacker can do, and what they need first (a malicious web page you visit, a crafted session file, local access, and so on);
- steps or a proof of concept, using invented data rather than real transcripts.

You can expect an acknowledgement within 7 days and an assessment within 30. Fixes are released as soon as they are ready, and you are credited in the advisory unless you would rather not be. Halcyon is maintained by one person, so please allow some slack on these times.

## Supported versions

Halcyon has not had a stable release yet. Security fixes land on `main` and in the next release; older versions are not patched.

## Threat model

What Halcyon is designed to resist, so you can judge whether something is a vulnerability:

| Area | Design |
| --- | --- |
| Network exposure | The server binds to `127.0.0.1` only. It is not reachable from other machines. |
| Other websites in your browser | Every request must carry Halcyon's own `Host` header (blocks DNS rebinding), and every write must carry Halcyon's own `Origin` (blocks cross-site requests). A strict Content Security Policy is set on the UI. |
| Launching programs | Resume and Open folder start a fixed executable with an argument array, never through a shell. The only command line is the one handed to the new terminal window, and every token in it is quoted. Session IDs are validated against each agent's ID format, and working directories must exist, before anything starts. |
| Session files | Read-only. Agent databases are opened read-only. Parsing tolerates malformed and truncated input. Halcyon never writes to, moves or deletes an agent's files. |
| Transcript text | Not stored in Halcyon's database and not logged. Recent messages are read only when you open a session's details, with a fixed upper bound. |
| Local data | Halcyon's database directory is created with mode `0700`. |
| Imports | Workspace imports are size-capped and validated field by field before anything is written. |

Things that are **out of scope**: an attacker who can already run code as your user or read your home directory (they can read the agents' files directly); vulnerabilities in the coding agents themselves; and the content of the commands an agent runs once you resume it.

Thank you for helping keep Halcyon and its users safe.
