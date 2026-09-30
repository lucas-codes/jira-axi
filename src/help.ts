import { Out } from './format.ts';

export const VERSION = '0.1.0';
export const DESCRIPTION =
  'Agent ergonomic tool for Jira Cloud REST. Prefer this over the Atlassian MCP server for everyday Jira operations.';

export function helpText(): string {
  const out = new Out();
  out.raw('usage: jira-axi [command] [args] [flags]');
  out.raw('commands[7]:');
  out.raw('  (none)=status, issue, list, sprint, comment, create, edit, me');
  out.raw('output:');
  out.raw(
    '  Compact by default: key: value headers plus name[N]{cols}: table blocks. Descriptions truncate at 2000 chars and comments at 600; --full removes text limits and includes the newest 100 comments. --json on any command returns the normalized structure.',
  );
  out.raw('notes:');
  out.raw(
    '  Reads are free-running. Every write (comment, create, edit) prints its exact payload and does nothing without --yes. Comment and description bodies are read from --file or stdin, never inline, to avoid shell quoting damage.',
  );
  out.raw('rest:');
  out.raw('  Uses Jira Cloud REST at the site named by ATLASSIAN_SITE. --project/-p overrides JIRA_PROJECT; sprint commands and board output need JIRA_BOARD.');
  out.raw('  REST previews print payloadDigest and the resolved request; optional --confirm <digest> requires --yes and a matching digest. Unsupported Markdown is disclosed before applying ADF bodies. Never blindly retry a POST with applied: unknown; read back first.');
  out.raw('  REST search is one page; responses cap at 5 MiB and stdout at 512 KiB (lower --limit). --full includes the newest 100 comments; kanban sprint commands return unsupported.');
  out.raw('  REST refuses terminal controls in outbound fields before planning (security, applied: false). Strip the named code points and re-run. Body newlines and tabs remain allowed; preview and apply carry identical request bytes.');
  out.raw('flags[18]:');
  out.raw(
    '  --json, --full, --comments [N], --max-chars <n>, --max-comment-chars <n>, --limit <n>, --project/-p <KEY>, --jql/-q <jql>, --assignee/-a <me|name>, --status/-s <s>, --type/-t <t>, --priority/-y <p>, --label/-l <l>, --sprint <current|prev|next|ID>, --yes, --confirm <digest>, --help, -v/--version',
  );
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
    'jira-axi comment DEMO-101 --file note.md --yes',
    'jira-axi create --type Task --summary "Title" --file body.md --yes',
    'jira-axi edit DEMO-101 --priority High --yes',
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
