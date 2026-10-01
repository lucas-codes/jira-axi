# jira-axi

Agent-ergonomic tool for Jira Cloud REST reads and writes. It prints compact,
token-efficient output for everyday Jira work without the Atlassian MCP server.

## Install

```sh
npm install -g jira-axi     # or: volta install jira-axi
```

Requires Node 22+. Calls Jira Cloud directly at the site you configure.

## Setup

### 1. Create an Atlassian API token

1. Sign in at <https://id.atlassian.com/manage-profile/security/api-tokens>.
2. Choose **Create API token**. This is the classic, non-scoped token the tool
   uses with Basic auth; do not pick "Create API token with scopes".
3. Name the token and set an expiry.
4. Copy the token when it is shown; Atlassian displays it only once.

### 2. Set the environment

```sh
export ATLASSIAN_SITE=your-site.atlassian.net
export ATLASSIAN_EMAIL=you@example.com
export ATLASSIAN_API_TOKEN=...
export JIRA_PROJECT=DEMO   # optional default project
export JIRA_BOARD=42       # optional board id, needed for sprint/board output
```

How you supply these values is up to you.

- `ATLASSIAN_SITE` is required: `your-site.atlassian.net` or
  `https://your-site.atlassian.net`. Anything else (other hosts, `http`, paths,
  ports, credentials in the URL) is rejected, and requests are only ever sent to
  that one origin.
- `ATLASSIAN_EMAIL` and `ATLASSIAN_API_TOKEN` are required; they are the only
  credentials the tool reads.
- `JIRA_PROJECT` is the default project key. `--project`/`-p` overrides it. A
  command that needs a project (for example `list` without a `--jql` project
  clause, `create`, or a bare issue number) fails with a usage error when
  neither is set.
- `JIRA_BOARD` is a positive board id. Sprint commands (`sprint`,
  `list --sprint ...`) need it and apply to the configured project only;
  `status` shows the board name only when it is set. Sprint commands on kanban
  boards return `unsupported`, while scrum boards support the bounded sprint
  window.

```sh
jira-axi me
jira-axi list --assignee me
```

REST reads have a 5 MiB response cap and 512 KiB output cap; lower `--limit`
if either is exceeded. Search returns one page (no automatic pagination).
`issue --full` includes the newest 100 comments, with shown/total disclosed.

REST writes still require `--yes`. Preview resolution uses only GETs and
prints `payloadDigest`; `--json` includes the exact request object.
`--confirm <digest>` is optional, requires `--yes`, and refuses a mismatch.
Markdown bodies become ADF using the
owned subset (headings, paragraphs, lists, code, quotes, rules, inline marks,
and HTTP(S) links); previews disclose unsupported tables, HTML, images and
unsafe links as literal text. Assignees must resolve to exactly one active,
case-insensitive name or email match; edit `--assignee x` unassigns.

No write is retried automatically. An uncertain outcome reports
`applied: unknown` and a read-back command; do not blindly repeat a POST.
An edit applies fields and assignee atomically in one PUT. REST refuses terminal
control characters in outbound text before planning, naming the field and escaped
code point. Strip them and re-run; ordinary body newlines and tabs remain allowed.
Preview and apply carry the same unsanitized request bytes.

## Usage

```
usage: jira-axi [command] [args] [flags]
commands[9]:
  (none)=status, issue, list, sprint, transitions, comment, create, edit, transition, me
```

### Reads

```sh
jira-axi                            # who/where am I, is auth working
jira-axi issue DEMO-101             # compact issue view
jira-axi issue DEMO-101 --comments  # + the 10 most recent comments
jira-axi issue DEMO-101 --full      # every field, nothing truncated
jira-axi list --assignee me
jira-axi list --status "In Progress" --limit 20 --full
jira-axi list --jql "project = DEMO AND labels = infra"
jira-axi list --sprint current
jira-axi sprint
jira-axi transitions DEMO-101       # id, name and target status of each available transition
```

A bare issue key works too: `jira-axi DEMO-101`.

### Output shape

```
key: DEMO-101
summary: [SPIKE] Evaluate local LLMs for coding assistance and problem solving
type: Task
status: In Progress
priority: High
assignee: Alex Example
components: Platform Internals
updated: 2026-09-15
url: https://example.atlassian.net/browse/DEMO-101
description[1999/3087 chars]:
  Assess which categories of development work can be offloaded to ...
help[1]:
  Run `jira-axi issue DEMO-101 --full` for untruncated text and every field
```

Scalars are `key: value`. Collections are `name[N]{col,col}:` blocks with
CSV-ish rows indented two spaces — quoted only where a value would otherwise be
ambiguous. `[1999/3087 chars]` means the text was truncated and by how much.
`--json` on any command returns the normalized structure instead.

### Token economy

Defaults are deliberately lossy and say so:

| | default | `--full` |
|---|---|---|
| description | 2000 chars | unlimited |
| each comment | 600 chars | unlimited |
| comments included | only with `--comments` | newest 100 |
| list summary | 90 chars | unlimited |

`--max-chars` and `--max-comment-chars` override the description and comment
limits for one call.

### Writes

Write paths exist and are deliberately hard to trigger by accident:

- the target is always an explicit, validated issue key — never inferred;
- the command prints exactly what it will send and does nothing without `--yes`;
- comment and description bodies come from `--file <path>` or stdin, never an
  inline shell argument, so multi-line Jira content cannot be mangled by quoting.

```sh
jira-axi comment DEMO-101 --file note.md          # prints the payload, sends nothing
jira-axi comment DEMO-101 --file note.md --yes    # sends it
cat note.md | jira-axi comment DEMO-101 --yes

jira-axi create --type Task --summary "Title" --file body.md --yes
jira-axi edit DEMO-101 --priority High --assignee "Some One" --yes

jira-axi transition DEMO-101 --to "In Progress"       # prints the payload, sends nothing
jira-axi transition DEMO-101 --to "In Progress" --yes
```

`transition` moves an issue through its workflow. `--to` is matched
case-insensitively against each available transition's name and its target
status (see `jira-axi transitions DEMO-101`). An unknown or ambiguous name fails
and lists the options, so nothing is guessed. A transition whose screen has
required fields is refused with those fields named; Jira Cloud needs them
supplied, which this command does not do, so perform that transition in Jira.
After applying, the issue is read back and its new status printed. Like every
POST, an uncertain outcome reports `applied: unknown`; read the issue before
retrying.

## Auth

Credentials come only from `ATLASSIAN_EMAIL` plus `ATLASSIAN_API_TOKEN` in the
environment, and the site from `ATLASSIAN_SITE`. If any of them is missing the
tool says so and points at [Setup](#setup) above. Token values are never logged
or printed; output is redacted and outbound secrets are refused. Errors carry
stable `code:` values such as `token_missing`, `unauthorized`, `not_found`, and
`usage` so callers can branch without string matching.

## Development

```sh
npm run typecheck
npm test          # node --test, recorded fixtures, no network
npm run build     # bun build --target=node -> dist/
```

Tests never touch the network. Fixtures under `src/__tests__/fixtures/`
include recorded responses and hand-built REST cases.
