import { assertKnownFlags, flagBool, flagNum, flagStr, type Args } from '../args.ts';
import { read } from '../api.ts';
import { adfToText } from '../adf.ts';
import { JiraError } from '../jira.ts';
import { parseIssue, parseIssueList, parseSprints } from '../model.ts';
import { renderIssue, renderIssueList, renderSprints } from '../render.ts';
import { cleanModel, secrets } from '../security.ts';
import { configuredProject, requireBoard, siteOrigin, EPIC_LINK_FIELD, ISSUE_FIELDS, KEY_RE, SPRINT_FIELD } from '../site.ts';
import { object, project, projectKey, type Runtime } from '../rest.ts';
import { buildJql } from '../jql.ts';
export const ISSUE_FLAGS = ['full', 'comments', 'json', 'max-chars', 'max-comment-chars', 'project', 'p'];

export const LIST_FLAGS = [
  'jql', 'q', 'assignee', 'a', 'mine', 'status', 's', 'type', 't', 'priority', 'y',
  'label', 'l', 'parent', 'P', 'updated', 'created', 'watching', 'history', 'limit',
  'sprint', 'full', 'json', 'project', 'p',
];

export const SPRINT_FLAGS = ['state', 'json', 'project', 'p'];


const options = (runtime: Runtime) => ({ baseUrl: siteOrigin(runtime.env), epicLinkField: EPIC_LINK_FIELD, sprintField: SPRINT_FIELD, rest: true });
export function requireRestKey(raw: string | undefined, p: string | undefined): string {
  if (raw && /^\d+$/.test(raw) && !p)
    throw new JiraError('A bare issue number needs a project; pass --project or set JIRA_PROJECT', 'usage');
  const key = raw && (/^\d+$/.test(raw) ? `${p}-${raw}` : raw.toUpperCase());
  if (!key || !KEY_RE.test(key))
    throw new JiraError('An explicit valid issue key is required', 'usage');
  return key;
}
export function issueShape(raw: unknown): Record<string, unknown> {
  const r = object(raw);
  if (typeof r.key !== 'string' || !r.key)
    throw new JiraError('Malformed issue', 'bad_response');
  const fields = object(r.fields);
  if (fields.comment != null)
    commentShape(fields.comment);
  return r;
}
function commentShape(raw: unknown): Record<string, unknown> {
  const r = object(raw);
  if (!Array.isArray(r.comments) || !Number.isInteger(r.total))
    throw new JiraError('Malformed comment page', 'bad_response');
  for (const c of r.comments) {
    const b = object(c).body;
    if (!b || typeof b !== 'object')
      throw new JiraError('Malformed comment body', 'bad_response');
    adfToText(b);
  }
  return r;
}
export async function sprintWindow(args: Args, runtime: Runtime, state: string): Promise<unknown[]> {
  const board = requireBoard(runtime.env);
  const configured = configuredProject(runtime.env);
  if (project(args, runtime.env) !== configured)
    throw new JiraError(configured ? `Sprint board ${board} is fixed to project ${configured}` : `Sprint board ${board} needs JIRA_PROJECT to name its project`, 'usage');
  if (!/^(active|future|closed)(,(active|future|closed))*$/.test(state))
    throw new JiraError('Invalid sprint state', 'usage');
  const values: unknown[] = [];
  let start = 0;
  for (let page = 0; page < 20; page++) {
    const data = object(await read(`/rest/agile/1.0/board/${board}/sprint`, new URLSearchParams({ state, maxResults: '50', startAt: String(start) }), runtime));
    if (!Array.isArray(data.values) || typeof data.isLast !== 'boolean')
      throw new JiraError('Malformed sprint page', 'bad_response');
    for (const entry of data.values) {
      const s = object(entry);
      if (!Number.isSafeInteger(s.id) || Number(s.id) <= 0 || typeof s.name !== 'string' || !s.name || !['active', 'future', 'closed'].includes(String(s.state)))
        throw new JiraError('Malformed sprint member', 'bad_response');
    }
    if (!data.values.length && !data.isLast)
      throw new JiraError('Empty non-final sprint page', 'bad_response');
    values.push(...data.values);
    start += data.values.length;
    if (data.isLast)
      return values.slice(-50);
  }
  throw new JiraError('Sprint pagination exceeds 20 pages', 'response_too_large');
}
export async function restRead(args: Args, runtime: Runtime): Promise<string> {
  const name = args.command;
  const p = projectKey(args, runtime.env);
  const json = flagBool(args, 'json');
  const full = flagBool(args, 'full');
  const hidden = secrets(runtime.env);
  if (name === 'issue' || name === 'view') {
    assertKnownFlags(args, ISSUE_FLAGS);
    const key = requireRestKey(args.positional[0], p);
    const raw = issueShape(await read(`/rest/api/3/issue/${key}`, new URLSearchParams({ fields: ISSUE_FIELDS }), runtime));
    const want = flagBool(args, 'comments') || full;
    const n = full ? 100 : Math.min(100, Math.max(1, Math.trunc(flagNum(args, 'comments') ?? (want ? 10 : 1))));
    const comments = commentShape(await read(`/rest/api/3/issue/${key}/comment`, new URLSearchParams({ orderBy: '-created', maxResults: String(n) }), runtime));
    (raw.fields as Record<string, unknown>).comment = { ...comments, comments: [...(comments.comments as unknown[])].reverse() };
    const model = cleanModel(parseIssue(raw, options(runtime)), hidden);
    return json ? JSON.stringify(model, null, 2) : renderIssue(model, { full, comments: want, descriptionChars: flagNum(args, 'max-chars'), commentChars: flagNum(args, 'max-comment-chars') });
  }
  if (name === 'sprint') {
    assertKnownFlags(args, SPRINT_FLAGS);
    const values = await sprintWindow(args, runtime, flagStr(args, 'state') ?? 'active,closed');
    const sprints = cleanModel(parseSprints(values.reverse()), hidden);
    return json ? JSON.stringify({ count: sprints.length, sprints }, null, 2) : renderSprints(sprints);
  }
  assertKnownFlags(args, LIST_FLAGS);
  const parentRaw = flagStr(args, 'parent', 'P');
  const parent = parentRaw ? requireRestKey(parentRaw, p) : undefined;
  const sprintArg = flagStr(args, 'sprint');
  let sprint: number | undefined;
  if (sprintArg) {
    if (/^[1-9]\d*$/.test(sprintArg) && Number.isSafeInteger(Number(sprintArg)))
      sprint = Number(sprintArg);
    else {
      const state = ({ current: 'active', active: 'active', next: 'future', prev: 'closed', previous: 'closed' } as Record<string, string>)[sprintArg];
      if (!state)
        throw new JiraError('Invalid sprint selector', 'usage');
      const values = await sprintWindow(args, runtime, state);
      if (!values.length)
        throw new JiraError(`board ${requireBoard(runtime.env)} has no sprints in state ${state}`, 'not_found');
      sprint = Number(object(state === 'future' ? values[0] : values.at(-1)).id);
    }
  }
  const jql = buildJql(args, p, sprint, parent);
  const limit = Math.max(1, Math.min(100, Math.trunc(flagNum(args, 'limit') ?? 30)));
  const data = object(await read('/rest/api/3/search/jql', new URLSearchParams({ jql, maxResults: String(limit), fields: ISSUE_FIELDS + ',comment' }), runtime));
  if (!Array.isArray(data.issues) || typeof data.isLast !== 'boolean')
    throw new JiraError('Malformed search response', 'bad_response');
  for (const raw of data.issues)
    issueShape(raw);
  const issues = cleanModel(parseIssueList(data, options(runtime)), hidden);
  const described: string[] = [];
  const rawJql = flagStr(args, 'jql', 'q');
  if (rawJql)
    described.push(`jql=${rawJql}`);
  let assignee = flagStr(args, 'assignee', 'a');
  if (flagBool(args, 'mine'))
    assignee = 'me';
  if (assignee)
    described.push(`assignee=${assignee}`);
  for (const [field, names] of [['status', ['status', 's']], ['type', ['type', 't']], ['priority', ['priority', 'y']], ['label', ['label', 'l']], ['parent', ['parent', 'P']], ['updated', ['updated']], ['created', ['created']]] as [
    string,
    string[]
  ][]) {
    const value = flagStr(args, ...names);
    if (value)
      for (const v of (field === 'status' || field === 'label' ? value.split(',') : [value]))
        described.push(`${field}=${v.trim()}`);
  }
  if (args.positional.length)
    described.push(`text=${args.positional.join(' ')}`);
  if (sprintArg)
    described.push(`sprint=${sprintArg}`);
  const query = cleanModel(described.join(' ') || `project=${p}`, hidden);
  return json ? JSON.stringify({ query, count: issues.length, issues }, null, 2) : renderIssueList(issues, { full, query });
}
