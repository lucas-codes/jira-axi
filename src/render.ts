/** Compact renderers for the normalized issue model. */

import { truncate } from './adf.ts';
import { Out, csvCell } from './format.ts';
import type { Issue, Sprint } from './model.ts';

export const DEFAULT_DESCRIPTION_CHARS = 2000;
export const DEFAULT_COMMENT_CHARS = 600;
export const DEFAULT_SUMMARY_CHARS = 90;

export interface RenderIssueOptions {
  full: boolean;
  comments: boolean;
  descriptionChars?: number;
  commentChars?: number;
}

export function renderIssue(issue: Issue, opts: RenderIssueOptions): string {
  const out = new Out();
  const descLimit = opts.full ? 0 : (opts.descriptionChars ?? DEFAULT_DESCRIPTION_CHARS);
  const commentLimit = opts.full ? 0 : (opts.commentChars ?? DEFAULT_COMMENT_CHARS);

  out.kv('key', issue.key);
  out.kv('summary', issue.summary);
  out.kv('type', issue.type);
  out.kv(
    'status',
    issue.statusCategory && issue.statusCategory !== issue.status
      ? `${issue.status} (${issue.statusCategory})`
      : issue.status,
  );
  out.kv('priority', issue.priority);
  out.kv('assignee', issue.assignee);
  if (opts.full) out.kv('reporter', issue.reporter);
  if (issue.resolution) out.kv('resolution', issue.resolution);
  if (issue.sprint) {
    out.kv('sprint', issue.sprintState ? `${issue.sprint} (${issue.sprintState})` : issue.sprint);
  }
  if (issue.parent) {
    out.kv('parent', issue.parent.summary ? `${issue.parent.key} ${issue.parent.summary}` : issue.parent.key);
  }
  if (issue.epic) out.kv('epic', issue.epic);
  if (issue.labels.length || opts.full) out.kv('labels', issue.labels.join(',') || '-');
  if (issue.components.length || opts.full) out.kv('components', issue.components.join(',') || '-');
  if (opts.full && issue.fixVersions.length) out.kv('fixVersions', issue.fixVersions.join(','));
  if (opts.full && issue.estimate) out.kv('estimate', issue.estimate);
  if (opts.full && issue.due) out.kv('due', issue.due);
  out.kv('updated', issue.updated);
  if (opts.full) out.kv('created', issue.created);
  if (issue.url) out.kv('url', issue.url);

  if (issue.description) {
    const t = truncate(issue.description, descLimit);
    const header = t.truncated ? `description[${t.text.length}/${t.fullLength} chars]` : 'description';
    out.text(header, t.text);
  }

  if (issue.subtasks.length) {
    out.table(
      'subtasks',
      ['key', 'status', 'summary'],
      issue.subtasks.map((s) => [s.key, s.status ?? '-', clip(s.summary, opts.full)]),
    );
  }
  if (issue.links.length) {
    out.table(
      'links',
      ['relation', 'key', 'status', 'summary'],
      issue.links.map((l) => [l.type, l.key, l.status ?? '-', clip(l.summary, opts.full)]),
    );
  }

  if (opts.comments || opts.full) {
    if (issue.comments.length === 0) {
      out.kv('comments', 0);
    } else {
      const shown = issue.comments.length;
      out.raw(`comments[${shown === issue.commentTotal ? shown : `${shown}/${issue.commentTotal}`}]:`);
      for (const c of issue.comments) {
        const t = truncate(c.body, commentLimit);
        out.raw(`  ${c.created} ${csvCell(c.author)}${t.truncated ? ` [${t.text.length}/${t.fullLength} chars]` : ''}:`);
        for (const line of t.text.split('\n')) out.raw(line ? '    ' + line : '');
      }
    }
  } else if (issue.commentTotal > 0) {
    out.kv('comments', issue.commentTotal);
  }

  const hints: string[] = [];
  if (!opts.comments && !opts.full && issue.commentTotal > 0) {
    hints.push(`Run \`jira-axi issue ${issue.key} --comments\` to read the ${issue.commentTotal} comment(s)`);
  }
  if (!opts.full) {
    hints.push(`Run \`jira-axi issue ${issue.key} --full\` for untruncated text and every field`);
  }
  out.list('help', hints);
  return out.toString();
}

function clip(s: string | undefined, full: boolean): string {
  if (!s) return '-';
  if (full || s.length <= DEFAULT_SUMMARY_CHARS) return s;
  return s.slice(0, DEFAULT_SUMMARY_CHARS - 1) + '…';
}

export interface RenderListOptions {
  full: boolean;
  query: string;
  hints?: string[];
}

export function renderIssueList(issues: Issue[], opts: RenderListOptions): string {
  const out = new Out();
  out.kv('query', opts.query);
  const columns = opts.full
    ? ['key', 'type', 'status', 'priority', 'assignee', 'updated', 'labels', 'summary']
    : ['key', 'type', 'status', 'assignee', 'summary'];
  const rows = issues.map((i) =>
    opts.full
      ? [i.key, i.type, i.status, i.priority ?? '-', i.assignee ?? '-', i.updated ?? '-', i.labels.join('|') || '-', i.summary]
      : [i.key, i.type, i.status, i.assignee ?? '-', clip(i.summary, false)],
  );
  out.table('issues', columns, rows);
  const hints = opts.hints ? [...opts.hints] : [];
  if (issues.length === 0) {
    hints.push('No issues matched. Widen the filters or pass --jql for a raw query.');
  } else if (opts.full) {
    hints.push(`Run \`jira-axi issue ${issues[0]!.key}\` to read one`);
  } else {
    hints.push(`Run \`jira-axi issue ${issues[0]!.key}\` to read one, or --full for priority, labels and dates`);
  }
  out.list('help', hints);
  return out.toString();
}

export function renderSprints(sprints: Sprint[]): string {
  const out = new Out();
  out.table(
    'sprints',
    ['id', 'name', 'state', 'start', 'end'],
    sprints.map((s) => [s.id ?? '-', s.name, s.state ?? '-', s.start ?? '-', s.end ?? '-']),
  );
  return out.toString();
}
