import { assertKnownFlags, flagBool, flagStr, type Args } from '../args.ts';
import { read, write } from '../api.ts';
import { Out } from '../format.ts';
import { JiraError } from '../jira.ts';
import { object, projectKey, type Runtime } from '../rest.ts';
import { assertNoSecrets, assertOutboundText, cleanModel, secrets } from '../security.ts';
import { siteOrigin } from '../site.ts';
import { confirmWrite, payloadDigest, type PlannedWrite } from '../write-plan.ts';
import { issueShape, requireRestKey } from './rest-read.ts';

export const TRANSITIONS_FLAGS = ['json', 'project', 'p'];
export const TRANSITION_FLAGS = ['to', 'yes', 'confirm', 'json', 'project', 'p'];

interface Transition {
  id: string;
  name: string;
  to: string;
  hasScreen: boolean;
  /** Screen fields Jira insists on and will not default; only populated when the request asked for `transitions.fields`. */
  required: string[];
}

/** Parse and validate the transitions array from a Jira response, including any required screen fields. */
function parseTransitions(raw: unknown): Transition[] {
  const data = object(raw);
  if (!Array.isArray(data.transitions))
    throw new JiraError('Malformed transitions response', 'bad_response');
  return data.transitions.map(value => {
    const t = object(value);
    const to = object(t.to);
    if (typeof t.id !== 'string' || !t.id || typeof t.name !== 'string' || !t.name || typeof to.name !== 'string' || !to.name || (t.hasScreen != null && typeof t.hasScreen !== 'boolean'))
      throw new JiraError('Malformed transition', 'bad_response');
    const fields = t.fields == null ? {} : object(t.fields);
    const required = Object.entries(fields).flatMap(([id, field]) => {
      const f = object(field);
      return f.required === true && f.hasDefaultValue !== true ? [typeof f.name === 'string' && f.name ? f.name : id] : [];
    });
    return { id: t.id, name: t.name, to: to.name, hasScreen: t.hasScreen === true, required };
  });
}

/** Fetch an issue's requested `fields` and return its summary (if asked for) plus its current status name. */
async function issueStatus(key: string, fields: string, runtime: Runtime): Promise<{ summary: string | undefined; status: string }> {
  const raw = issueShape(await read(`/rest/api/3/issue/${key}`, new URLSearchParams({ fields }), runtime));
  if (raw.key !== key)
    throw new JiraError(`Issue moved to ${raw.key}`, 'issue_moved');
  const f = object(raw.fields);
  const status = object(f.status).name;
  if (typeof status !== 'string' || !status)
    throw new JiraError('Malformed issue status', 'bad_response');
  return { summary: typeof f.summary === 'string' ? f.summary : undefined, status };
}

const options = (list: Transition[]) => list.map(t => `${t.id} ${JSON.stringify(t.name)} -> ${t.to}`).join('; ');

/** `transitions <KEY>`: list the transitions available from an issue's current status. */
export async function restTransitions(args: Args, runtime: Runtime): Promise<string> {
  assertKnownFlags(args, TRANSITIONS_FLAGS);
  if (args.positional.length > 1)
    throw new JiraError('transitions takes one issue key', 'usage');
  const key = requireRestKey(args.positional[0], projectKey(args, runtime.env));
  const list = parseTransitions(await read(`/rest/api/3/issue/${key}/transitions`, new URLSearchParams(), runtime));
  const rows = cleanModel(list.map(t => ({ id: t.id, name: t.name, to: t.to, hasScreen: t.hasScreen })), secrets(runtime.env));
  if (flagBool(args, 'json'))
    return JSON.stringify({ issue: key, count: rows.length, transitions: rows }, null, 2);
  return new Out()
    .kv('issue', key)
    .table('transitions', ['id', 'name', 'to', 'screen'], rows.map(t => [t.id, t.name, t.to, t.hasScreen]))
    .list('help', [`Run \`jira-axi transition ${key} --to "<name or status>"\` to preview one`])
    .toString();
}

/** `transition <KEY> --to <name>`: apply the matching transition, previewing the plan unless --yes is given. */
export async function restTransition(args: Args, runtime: Runtime): Promise<string> {
  const json = flagBool(args, 'json');
  const hidden = secrets(runtime.env);
  assertKnownFlags(args, TRANSITION_FLAGS);
  if (args.positional.length > 1)
    throw new JiraError('transition takes one issue key; name the transition with --to', 'usage');
  const wanted = flagStr(args, 'to')?.trim();
  if (!wanted)
    throw new JiraError('transition requires --to <transition or status name>', 'usage', 'List them with `jira-axi transitions <KEY>`.');
  assertOutboundText('to', wanted);
  const key = requireRestKey(args.positional[0], projectKey(args, runtime.env));

  const before = await issueStatus(key, 'summary,status', runtime);
  const list = parseTransitions(await read(`/rest/api/3/issue/${key}/transitions`, new URLSearchParams({ expand: 'transitions.fields' }), runtime));
  const needle = wanted.toLowerCase();
  const matches = list.filter(t => t.name.toLowerCase() === needle || t.to.toLowerCase() === needle);
  if (matches.length !== 1) {
    const shown = matches.length ? matches : list;
    throw new JiraError(
      matches.length ? `Transition "${wanted}" is ambiguous` : `No transition of ${key} is named or leads to "${wanted}"`,
      matches.length ? 'ambiguous_transition' : 'not_found',
      `${matches.length ? 'Matching' : 'Available'}: ${options(shown) || 'none'}. Pass --to with the exact name.`,
    );
  }
  const chosen = matches[0]!;
  if (chosen.required.length)
    throw new JiraError(
      `Transition "${chosen.name}" has a screen with required fields`,
      'transition_screen',
      `Required: ${chosen.required.join(', ')}. jira-axi does not supply screen fields; perform this transition in Jira.`,
    );

  const plan: PlannedWrite = { method: 'POST', path: `/rest/api/3/issue/${key}/transitions`, query: {}, body: { transition: { id: chosen.id } } };
  assertNoSecrets(JSON.stringify(plan), hidden);
  const grant = confirmWrite(args, plan);
  const summary = { action: 'transition-issue', payloadDigest: payloadDigest(plan), issue: key, from: before.status, transition: chosen.name, to: chosen.to };
  if (!grant) {
    const preview = { ...cleanModel({ ...summary, applied: false, ...(before.summary ? { target: before.summary } : {}) }, hidden), request: plan };
    if (json)
      return JSON.stringify(preview, null, 2);
    return new Out()
      .kv('action', preview.action).kv('payloadDigest', preview.payloadDigest).kv('issue', key).kvIf('target', preview.target)
      .kv('from', preview.from).kv('transition', preview.transition).kv('to', preview.to)
      .text('request', JSON.stringify(plan, null, 2)).kv('applied', false)
      .list('help', ['Nothing was sent to Jira. Re-run the identical command with --yes to apply it.'])
      .toString();
  }

  const readBack = `jira-axi issue ${key}`;
  try {
    await write(plan, grant, runtime);
  }
  catch (error) {
    if (error instanceof JiraError && error.details.applied === 'unknown') {
      const replacement = new JiraError(error.message, error.code, `Read back before retrying: ${readBack}. POSTs are not safe to retry automatically.`);
      replacement.details = error.details;
      throw replacement;
    }
    throw error;
  }
  // The write is acknowledged from here on: any failure must say so rather than look like an unapplied write.
  const acknowledged = (error: JiraError) => {
    error.details.applied = true;
    return error;
  };
  let status: string;
  try {
    status = (await issueStatus(key, 'status', runtime)).status;
  }
  catch (error) {
    throw acknowledged(new JiraError('Transition applied, but reading the new status failed', error instanceof JiraError ? error.code : 'transport_error', `Read back before retrying: ${readBack}`));
  }
  const applied = cleanModel({ ...summary, applied: true, status, url: `${siteOrigin(runtime.env)}/browse/${key}` }, hidden);
  const out = new Out();
  for (const [field, value] of Object.entries(applied))
    out.kv(field, value as string | boolean);
  const output = json ? JSON.stringify(applied, null, 2) : out.toString();
  try {
    assertNoSecrets(output, hidden);
  }
  catch {
    throw acknowledged(new JiraError('Transition applied, but output was refused', 'security', `Read back before retrying: ${readBack}`));
  }
  return output;
}
