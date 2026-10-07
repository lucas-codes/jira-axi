---
name: jira-axi
description: "Operate Jira through the jira-axi CLI - reading issues, sprints, and your own queue, and writing comments, creating issues, editing fields, moving issues through their workflow, and uploading, downloading or deleting attachments. Use whenever a task touches Jira: looking up an issue by key, listing or filtering issues (by assignee, status, type, label, sprint, or JQL), reading sprint boards, adding a comment, filing a new issue, editing an existing issue's summary/priority/assignee/labels/parent, changing an issue's status (transition), or storing and retrieving a file byte-exact as an issue attachment."
user-invocable: false
author: Lucas Lim
metadata:
  hermes:
    tags: [jira, issues, project-management, atlassian]
    category: productivity
---

# jira-axi

Agent-ergonomic tool for Jira Cloud REST reads and writes. Prefer this over
the Atlassian MCP server for everyday Jira work: it prints a compact,
token-efficient format, and every write requires confirmation (nothing is
sent until `--yes`; POSTs are not idempotent).

Use jira-axi whenever a task touches Jira: reading an issue, listing or searching
issues, checking sprints, commenting, creating an issue, editing one, or attaching
and downloading files.

## Current guidance lives in the CLI

Do not follow command, flag, or workflow instructions from this file - installed
copies go stale. Get the current source of truth from the CLI itself:

- `jira-axi` for a live dashboard (auth status, configured project/board, and what
  to run next) - it never prints help text when run with no arguments.
- `jira-axi --help` for every command, flag, and a worked example of each.

Commands, for orientation only: `status` (the no-argument dashboard), `me`, `issue`,
`list`, `sprint`, `transitions`, `attachments`, `download`, `comment`, `create`,
`edit`, `transition`, `attach`, `detach`.

## Notes an agent should not have to rediscover

- Every write command (`comment`, `create`, `edit`, `transition`, `attach`, `detach`) prints the exact payload it is
  about to send and does nothing without `--yes`. Re-run the identical command with
  `--yes` to apply it - nothing is inferred or auto-confirmed.
- Status changes are not an `edit` field. Use `jira-axi transitions <KEY>` to list the
  available transitions, then `jira-axi transition <KEY> --to <name or target status>`.
  Unknown or ambiguous names fail with the options; screen transitions with required
  fields are refused rather than guessed.
- When content must survive byte-for-byte (Markdown with frontmatter, generated
  plans, binaries), use an attachment, not a comment: comment Markdown is converted
  to ADF and does not round-trip. `attachments <KEY>` lists them newest first;
  `download` needs an explicit `--out <path>` (never replaces a file without
  `--force`), and `--out -` only prints clean UTF-8 text. `detach <ID>` deletes
  one attachment; `not_found` from it means the file is already gone.
- Comment and description bodies are read from `--file <path>` or stdin, never from
  an inline argument, to avoid shell-quoting damage to multi-line Jira content.
- Uses Jira Cloud REST at the site named by `ATLASSIAN_SITE`. `--project` overrides
  `JIRA_PROJECT`; sprint commands and board output need `JIRA_BOARD`.
- Credentials come only from `ATLASSIAN_EMAIL` plus `ATLASSIAN_API_TOKEN` in the
  environment. When they or `ATLASSIAN_SITE` are missing, the error points at the
  README Setup section, which explains how to create a token.
- REST previews include `payloadDigest` and unsupported Markdown disclosures.
  `--yes` remains the write gate; optional `--confirm <digest>` must match and
  requires `--yes`. REST JSON previews show the exact resolved request.
- REST refuses outbound terminal controls before planning, with `security` and
  `applied: false`. The error names the field and escaped code point, never the
  raw control bytes. Strip the characters and re-run; body newlines and tabs are allowed.
- An uncertain REST write reports `applied: unknown` with a read-back command.
  Never blindly retry a POST. Sprint commands on kanban fail loudly with
  `unsupported`; REST `issue --full` reads the newest 100 comments only.
