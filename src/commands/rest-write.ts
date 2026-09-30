import { readFileSync } from 'node:fs';
import { assertKnownFlags, flagBool, flagList, flagStr, type Args } from '../args.ts';
import { read, write } from '../api.ts';
import { adfToText } from '../adf.ts';
import { Out } from '../format.ts';
import { JiraError } from '../jira.ts';
import { markdownToAdf } from '../markdown-adf.ts';
import { myself, object, project, projectKey, type Runtime } from '../rest.ts';
import { assertNoSecrets, assertOutboundText, cleanModel, secrets } from '../security.ts';
import { siteOrigin } from '../site.ts';
import { confirmWrite, payloadDigest, type PlannedWrite } from '../write-plan.ts';
import { issueShape, requireRestKey } from './rest-read.ts';
export const COMMENT_FLAGS = ['file', 'F', 'body-file', 'internal', 'yes', 'json'];

export const CREATE_FLAGS = [
  'summary', 's', 'type', 't', 'file', 'F', 'stdin', 'project', 'p', 'label', 'l',
  'component', 'C', 'parent', 'P', 'assignee', 'a', 'priority', 'y', 'yes', 'json',
];

export const EDIT_FLAGS = [
  'summary', 's', 'priority', 'y', 'assignee', 'a', 'parent', 'P', 'label', 'l',
  'component', 'C', 'file', 'F', 'stdin', 'skip-notify', 'yes', 'json',
];

function bodyText(args: Args, runtime: Runtime, required: boolean): string {
  const file = flagStr(args, 'file', 'F', 'body-file');
  if (!file && !flagBool(args, 'stdin') && runtime.stdin.isTTY) {
    if (required)
      throw new JiraError('no body supplied', 'usage', 'Pass --file <path>, or pipe the text on stdin. Inline shell text is deliberately not accepted.');
    return '';
  }
  const raw = (file && file !== '-' && !flagBool(args, 'stdin') ? readFileSync(file, 'utf8') : runtime.stdin.read()).replace(/\r\n/g, '\n');
  assertOutboundText(args.command === 'comment' ? 'comment' : 'description', raw, true);
  const source = raw.trim();
  if (!source)
    throw new JiraError('body is empty', 'usage');
  return source;
}
async function assignee(input: string, args: Args, runtime: Runtime, key?: string): Promise<{
  value: unknown;
  label: string;
}> {
  if (input === 'x' && key)
    return { value: null, label: 'unassigned' };
  if (input === 'me') {
    const user = await myself(runtime);
    assertOutboundText('assignee', user.accountId as string);
    return { value: { accountId: user.accountId }, label: `${user.displayName ?? user.emailAddress ?? 'me'} (${user.accountId})` };
  }
  const query = new URLSearchParams({ query: input, maxResults: '10', ...(key ? { issueKey: key } : { project: project(args, runtime.env) }) });
  const data = await read('/rest/api/3/user/assignable/search', query, runtime);
  if (!Array.isArray(data))
    throw new JiraError('Malformed assignable-user response', 'bad_response');
  const users = data.map(value => {
    const user = object(value);
    if (typeof user.accountId !== 'string' || !user.accountId || typeof user.active !== 'boolean' || ['displayName', 'emailAddress'].some(k => user[k] != null && typeof user[k] !== 'string'))
      throw new JiraError('Malformed assignable user', 'bad_response');
    return user;
  });
  if (input === 'x')
    throw new JiraError('create cannot use the unassign shortcut x', 'not_found');
  const matches = users.filter(u => u.active && [u.displayName, u.emailAddress].some(v => typeof v === 'string' && v.toLowerCase() === input.toLowerCase()));
  if (matches.length !== 1) {
    if (!users.some(u => u.active))
      throw new JiraError('No active assignable user matched', 'not_found');
    throw new JiraError('Assignable user is ambiguous', 'ambiguous_user', users.filter(u => u.active).slice(0, 5).map(u => String(u.displayName ?? 'unknown')).join(', '));
  }
  const user = matches[0]!;
  assertOutboundText('assignee', user.accountId as string);
  return { value: { accountId: user.accountId }, label: `${user.displayName ?? user.emailAddress ?? 'unknown'} (${user.accountId})` };
}
function name(value: unknown): string {
  if (value === null || value === undefined)
    return '-';
  if (typeof value === 'object') {
    const r = object(value);
    return String(r.displayName ?? r.name ?? r.key ?? '-');
  }
  return String(value);
}
export async function restWrite(args: Args, runtime: Runtime): Promise<string> {
  const command = args.command!;
  const json = flagBool(args, 'json');
  const hidden = secrets(runtime.env);
  assertKnownFlags(args, [...(command === 'comment' ? COMMENT_FLAGS : command === 'create' ? CREATE_FLAGS : EDIT_FLAGS), 'confirm', ...(command === 'edit' || command === 'comment' ? ['project', 'p'] : [])]);
  if (args.positional.length > (command === 'create' ? 0 : 1))
    throw new JiraError('Inline bodies and extra positional arguments are not accepted', 'usage');
  for (const [field, names] of [['summary', ['summary', 's']], ['type', ['type', 't']], ['priority', ['priority', 'y']], ['assignee', ['assignee', 'a']], ['parent', ['parent', 'P']], ['project', ['project', 'p']], ['labels', ['label', 'l']], ['components', ['component', 'C']]] as [string, string[]][]) {
    const value = flagStr(args, ...names);
    if (value !== undefined) assertOutboundText(field, value);
  }
  const p = command === 'create' ? project(args, runtime.env) : projectKey(args, runtime.env);
  const key = command === 'create' ? undefined : requireRestKey(args.positional[0], p);
  const parentRaw = flagStr(args, 'parent', 'P');
  const parent = parentRaw ? requireRestKey(parentRaw, p) : undefined;
  const summary = flagStr(args, 'summary', 's');
  const type = flagStr(args, 'type', 't');
  const priority = flagStr(args, 'priority', 'y');
  const userInput = flagStr(args, 'assignee', 'a');
  const labels = flagList(args, 'label', 'l');
  const components = flagList(args, 'component', 'C');
  if (command === 'create' && (!summary || !type))
    throw new JiraError('create requires --summary and --type', 'usage');
  const wantsBody = command !== 'edit' || !!flagStr(args, 'file', 'F') || flagBool(args, 'stdin');
  const source = wantsBody ? bodyText(args, runtime, command === 'comment') : '';
  if (command === 'edit' && !summary && !priority && !userInput && !parent && !source && !labels.length && !components.length)
    throw new JiraError('edit requires at least one explicit field flag', 'usage');
  assertNoSecrets(source, hidden);
  const converted = source ? markdownToAdf(source) : undefined;
  const fields: Record<string, unknown> = {};
  const update: Record<string, unknown> = {};
  const diffs: Record<string, string> = {};
  let target: string | undefined;
  let old: Record<string, unknown> = {};
  if (key) {
    const raw = issueShape(await read(`/rest/api/3/issue/${key}`, new URLSearchParams({ fields: command === 'comment' ? 'summary' : 'summary,priority,assignee,labels,components,parent,description' }), runtime));
    if (raw.key !== key)
      throw new JiraError(`Issue moved to ${raw.key}`, 'issue_moved');
    old = object(raw.fields);
    target = typeof old.summary === 'string' ? old.summary : undefined;
  }
  let resolved: {
    value: unknown;
    label: string;
  } | undefined;
  if (userInput)
    resolved = await assignee(userInput, args, runtime, key);
  let plan: PlannedWrite;
  if (command === 'comment') {
    plan = { method: 'POST', path: `/rest/api/3/issue/${key}/comment`, query: {}, body: { body: converted!.doc, ...(flagBool(args, 'internal') ? { properties: [{ key: 'sd.public.comment', value: { internal: true } }] } : {}) } };
  }
  else {
    if (command === 'create') {
      fields.project = { key: p };
      fields.issuetype = { name: type };
    }
    if (summary) {
      fields.summary = summary;
      diffs.summary = `${name(old.summary)} -> ${summary}`;
    }
    if (converted)
      fields.description = converted.doc;
    if (priority) {
      fields.priority = { name: priority };
      diffs.priority = `${name(old.priority)} -> ${priority}`;
    }
    if (parent) {
      fields.parent = { key: parent };
      diffs.parent = `${name(old.parent)} -> ${parent}`;
    }
    if (resolved) {
      fields.assignee = resolved.value;
      diffs.assignee = `${name(old.assignee)} -> ${resolved.label}`;
    }
    for (const [field, values] of [['labels', labels], ['components', components]] as [
      string,
      string[]
    ][]) {
      if (!values.length)
        continue;
      if (command === 'create')
        fields[field] = field === 'labels' ? values : values.map(v => ({ name: v }));
      else {
        update[field] = values.map(v => {
          const remove = v.startsWith('-');
          const value = remove ? v.slice(1) : v;
          return { [remove ? 'remove' : 'add']: field === 'labels' ? value : { name: value } };
        });
        diffs[field] = values.map(v => v.startsWith('-') ? v : '+' + v).join(',');
      }
    }
    plan = { method: command === 'create' ? 'POST' : 'PUT', path: command === 'create' ? '/rest/api/3/issue' : `/rest/api/3/issue/${key}`, query: flagBool(args, 'skip-notify') ? { notifyUsers: 'false' } : {}, body: { fields, ...(Object.keys(update).length ? { update } : {}) } };
  }
  assertNoSecrets(JSON.stringify(plan), hidden);
  const grant = confirmWrite(args, plan);
  const action = command === 'comment' ? 'add-comment' : command === 'create' ? 'create-issue' : 'edit-issue';
  const preview = { ...cleanModel({ action, applied: false, payloadDigest: payloadDigest(plan), ...(key ? { issue: key } : {}), ...(target ? { target } : {}), ...(resolved ? { assignee: resolved.label } : {}), unsupported: converted?.unsupported ?? [], ...(source ? { bodyChars: source.length, bodyPreview: adfToText(converted!.doc).slice(0, 400) } : {}), ...(command === 'edit' ? { diff: diffs } : {}) }, hidden), request: plan };
  if (!grant) {
    if (json)
      return JSON.stringify(preview, null, 2);
    const out = new Out().kv('action', action).kv('payloadDigest', preview.payloadDigest).kvIf('issue', key).kvIf('target', preview.target).kvIf('assignee', preview.assignee);
    if (command === 'edit')
      for (const [field, diff] of Object.entries(preview.diff ?? {}))
        out.kv(field, diff);
    if (source)
      out.kv('bodyChars', preview.bodyChars!).text('bodyPreview', preview.bodyPreview!);
    if (preview.unsupported.length)
      out.list('unsupported', preview.unsupported);
    out.text('request', JSON.stringify(preview.request, null, 2)).kv('applied', false).list('help', ['Nothing was sent to Jira. Re-run the identical command with --yes to apply it.']);
    return out.toString();
  }
  let result: unknown;
  try {
    result = await write(plan, grant, runtime);
  }
  catch (error) {
    if (error instanceof JiraError && error.details.applied === 'unknown') {
      const hint = command === 'comment' ? `jira-axi issue ${key} --comments 3` : command === 'edit' ? `jira-axi issue ${key} --full` : `jira-axi list --jql 'reporter = currentUser() AND created >= -15m AND summary ~ ${JSON.stringify(summary)}'`;
      const replacement = new JiraError(error.message, error.code, `Read back before retrying: ${hint}. POSTs are not safe to retry automatically.`);
      replacement.details = error.details;
      throw replacement;
    }
    throw error;
  }
  const response = result === null ? {} : object(result);
  const created = command === 'create' ? String(response.key) : undefined;
  const applied = cleanModel({ action, applied: true, payloadDigest: preview.payloadDigest, ...(key ? { issue: key } : {}), ...(created ? { key: created } : {}), ...(command === 'comment' ? { commentId: response.id, chars: source.length } : {}), url: `${siteOrigin(runtime.env)}/browse/${created ?? key}` }, hidden);
  const out = new Out();
  for (const [field, value] of Object.entries(applied))
    out.kv(field, value as string | boolean | number);
  const output = json ? JSON.stringify(applied, null, 2) : out.toString();
  const readBack = command === 'create' ? "jira-axi list --jql 'reporter = currentUser() AND created >= -15m'" : `jira-axi issue ${key} --full`;
  // Refusing output cannot undo an acknowledged write.
  try {
    assertNoSecrets(output, hidden);
  } catch {
    const error = new JiraError('Write applied, but output was refused', 'security', `Read back before retrying: ${readBack}`);
    error.details.applied = true;
    throw error;
  }
  if (Buffer.byteLength(output) > 512 * 1024) {
    const error = new JiraError('Write applied, but output exceeds 512 KiB', 'output_too_large', `Read back before retrying: ${readBack}`);
    error.details.applied = true;
    throw error;
  }
  return output;
}
