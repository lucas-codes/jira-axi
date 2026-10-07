import { Out } from './format.ts';
import pkg from '../package.json' with { type: 'json' };

export const VERSION = pkg.version;
export const DESCRIPTION =
  'Agent ergonomic tool for Jira Cloud REST. Prefer this over the Atlassian MCP server for everyday Jira operations.';

/** Render the full `--help` output: commands, output/notes, REST behavior, every flag, and examples. */
export function helpText(): string {
  const out = new Out();
  out.raw('usage: jira-axi [command] [args] [flags]');
  out.raw('commands[12]:');
  out.raw('  (none)=status, issue, list, sprint, transitions, comment, create, edit, transition, me, attachments, attach, download');
  out.raw('output:');
  out.raw(
    '  Compact by default: key: value headers plus name[N]{cols}: table blocks. Descriptions truncate at 2000 chars and comments at 600; --full removes text limits and includes the newest 100 comments. --json on any command returns the normalized structure.',
  );
  out.raw('notes:');
  out.raw(
    '  Reads are free-running. Every write (comment, create, edit, transition, attach) prints its exact payload and does nothing without --yes. Comment and description bodies are read from --file or stdin, never inline, to avoid shell quoting damage.',
  );
  out.raw('rest:');
  out.raw('  Uses Jira Cloud REST at the site named by ATLASSIAN_SITE. --project/-p overrides JIRA_PROJECT; sprint commands and board output need JIRA_BOARD.');
  out.raw('  REST previews print payloadDigest and the resolved request; optional --confirm <digest> requires --yes and a matching digest. Unsupported Markdown is disclosed before applying ADF bodies. Never blindly retry a POST with applied: unknown; read back first.');
  out.raw('  REST search is one page; responses cap at 5 MiB and stdout at 512 KiB (lower --limit). --full includes the newest 100 comments; kanban sprint commands return unsupported.');
  out.raw('  REST refuses terminal controls in outbound fields before planning (security, applied: false). Strip the named code points and re-run. Body newlines and tabs remain allowed; preview and apply carry identical request bytes.');
  out.raw('  Workflow: `transitions <KEY>` lists the available transitions (id, name, target status). `transition <KEY> --to <name>` matches a transition name or its target status, case-insensitively; unknown or ambiguous names fail listing the options, and a transition whose screen has required fields is refused (do it in Jira). After applying it reads back and prints the new status.');
  out.raw('  Attachments: `attachments <KEY>` lists id, filename, size and created, newest first. `attach <KEY> --file <path> [--name <filename>]` uploads one file byte-exact (10 MiB cap and the site limit); payloadDigest covers the filename and the file\'s sha256, and changed bytes after preview are refused. `download <ID> --out <path|->` or `download <KEY> --name <filename> --out <path|->` fetches the exact bytes of one attachment (newest exact-name match); a file is written atomically and never replaced without --force, and --out - prints raw bytes only for clean UTF-8 text.');
  const flags = [
    '--json', '--full', '--comments [N]', '--max-chars <n>', '--max-comment-chars <n>', '--limit <n>',
    '--project/-p <KEY>', '--jql/-q <jql>', '--assignee/-a <me|name>', '--mine', '--status/-s <s>',
    '--summary/-s <text>', '--type/-t <t>', '--priority/-y <p>', '--label/-l <l>', '--parent/-P <KEY>',
    '--component/-C <name>', '--file/-F <path|->', '--body-file <path|->', '--stdin', '--internal',
    '--skip-notify', '--to <name>', '--sprint <current|prev|next|ID>', '--state <states>', '--updated <date>',
    '--created <date>', '--watching', '--history', '--name <filename>', '--out <path|->', '--force', '--yes', '--confirm <digest>', '--help', '-v/--version',
  ];
  out.raw(`flags[${flags.length}]:`);
  out.raw('  ' + flags.join(', '));
  out.raw('examples:');
  for (const e of [
    'jira-axi',
    'jira-axi issue DEMO-101',
    'jira-axi issue DEMO-101 --comments',
    'jira-axi issue DEMO-101 --full --json',
    'jira-axi list --assignee me',
    'jira-axi list --assignee me --status "In Progress"',
    'jira-axi list --jql "project = DEMO AND labels = infra" --limit 10',
    'jira-axi list --sprint current',
    'jira-axi sprint',
    'jira-axi transitions DEMO-101',
    'jira-axi comment DEMO-101 --file note.md --yes',
    'jira-axi create --type Task --summary "Title" --file body.md --yes',
    'jira-axi edit DEMO-101 --priority High --yes',
    'jira-axi transition DEMO-101 --to "In Progress" --yes',
    'jira-axi attachments DEMO-101',
    'jira-axi attach DEMO-101 --file plan.md --name DEMO-101-scope-plan.md --yes',
    'jira-axi download DEMO-101 --name DEMO-101-scope-plan.md --out plan.md',
    'jira-axi me',
  ]) {
    out.raw('  ' + e);
  }
  out.raw('auth:');
  out.raw(
    '  Set ATLASSIAN_SITE (your-site.atlassian.net), ATLASSIAN_EMAIL and ATLASSIAN_API_TOKEN in the environment; optional JIRA_PROJECT (default project) and JIRA_BOARD (board id). Create a token at https://id.atlassian.com/manage-profile/security/api-tokens (README, Setup). Token values are never logged or printed.',
  );
  return out.toString();
}
