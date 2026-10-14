import { assertKnownFlags, flagBool, flagStr, type Args } from '../args.ts';
import { read, remove, write } from '../api.ts';
import { Out } from '../format.ts';
import { JiraError } from '../jira.ts';
import { parseIssueLinks, parseLinkType, type IssueLink, type LinkType } from '../model.ts';
import { object, projectKey, type Runtime } from '../rest.ts';
import { assertNoSecrets, assertOutboundText, cleanModel, secrets } from '../security.ts';
import { KEY_RE, siteOrigin } from '../site.ts';
import { confirmWrite, payloadDigest, type PlannedDelete, type PlannedJsonWrite } from '../write-plan.ts';
import { issueShape, requireRestKey } from './rest-read.ts';

export const LINK_FLAGS = ['type', 'yes', 'confirm', 'json', 'project', 'p'];
export const UNLINK_FLAGS = ['yes', 'confirm', 'json'];

function resolveLinkType(needle: string, list: LinkType[], a: string, b: string): { type: LinkType; outward: string; inward: string } {
  const lower = needle.toLowerCase();
  const matches = [...new Map(list.filter(t => [t.name, t.inward, t.outward].some(s => s.toLowerCase() === lower)).map(t => [t.id, t])).values()];
  if (matches.length !== 1)
    throw new JiraError(matches.length ? `Link type "${needle}" is ambiguous` : `No link type matches "${needle}"`, matches.length ? 'ambiguous_link_type' : 'not_found', `Available: ${list.map(t => `${t.name} (${t.outward} / ${t.inward})`).join('; ') || 'none'}. Pass --type with an exact name or phrase.`);
  const type = matches[0]!;
  const flipped = type.name.toLowerCase() !== lower && type.outward.toLowerCase() !== lower;
  return { type, outward: flipped ? b : a, inward: flipped ? a : b };
}

async function issueLinks(key: string, runtime: Runtime): Promise<{ summary: string | undefined; links: IssueLink[] }> {
  const raw = issueShape(await read(`/rest/api/3/issue/${key}`, new URLSearchParams({ fields: 'summary,status,issuelinks' }), runtime));
  if (raw.key !== key)
    throw new JiraError(`Issue moved to ${raw.key}`, 'issue_moved');
  const fields = object(raw.fields);
  return { summary: typeof fields.summary === 'string' ? fields.summary : undefined, links: parseIssueLinks(fields.issuelinks) };
}

function sentences(type: LinkType, outward: string, inward: string): { reads: string; inverse: string } {
  return { reads: `${outward} ${type.outward} ${inward}`, inverse: `${inward} ${type.inward} ${outward}` };
}

export async function restLink(args: Args, runtime: Runtime): Promise<string> {
  assertKnownFlags(args, LINK_FLAGS);
  const json = flagBool(args, 'json');
  const hidden = secrets(runtime.env);
  if (args.positional.length !== 2)
    throw new JiraError('link takes exactly two issue keys', 'usage');
  const project = projectKey(args, runtime.env);
  const a = requireRestKey(args.positional[0], project);
  const b = requireRestKey(args.positional[1], project);
  if (a === b)
    throw new JiraError('An issue cannot link to itself', 'usage');
  const wanted = flagStr(args, 'type')?.trim();
  if (!wanted)
    throw new JiraError('link requires --type <name or phrase>', 'usage');
  assertOutboundText('type', wanted);
  const before = await issueLinks(a, runtime);
  const data = object(await read('/rest/api/3/issueLinkType', new URLSearchParams(), runtime));
  if (!Array.isArray(data.issueLinkTypes))
    throw new JiraError('Malformed link types response', 'bad_response');
  const { type, outward, inward } = resolveLinkType(wanted, data.issueLinkTypes.map(parseLinkType), a, b);
  const find = (links: IssueLink[]) => links.find(l => l.linkType.id === type.id && l.key === b && (type.inward === type.outward || l.direction === (a === outward ? 'outward' : 'inward')));
  const summary = { action: 'link-issues', type: type.name, outward, inward, ...sentences(type, outward, inward) };
  const existing = find(before.links);
  if (existing) {
    const result = cleanModel({ ...summary, applied: false, existing: true, linkId: existing.id, help: ['This link already exists. Nothing was sent to Jira.'] }, hidden);
    if (json) return JSON.stringify(result, null, 2);
    return new Out().kv('action', result.action).kv('type', result.type).kv('outward', result.outward).kv('inward', result.inward).kv('reads', result.reads).kv('inverse', result.inverse).kv('applied', false).kv('existing', true).kv('linkId', result.linkId).list('help', result.help).toString();
  }
  // GET issueLink/133547 showed inwardIssue ED-20571 reads "blocks" outwardIssue ED-21059 in issue/ED-20571.
  const plan: PlannedJsonWrite = { method: 'POST', path: '/rest/api/3/issueLink', query: {}, body: { type: { id: type.id }, inwardIssue: { key: outward }, outwardIssue: { key: inward } } };
  assertNoSecrets(JSON.stringify(plan), hidden);
  const grant = confirmWrite(args, plan);
  const planned = cleanModel({ ...summary, payloadDigest: payloadDigest(plan), ...(before.summary ? { target: before.summary } : {}) }, hidden);
  if (!grant) {
    if (json) return JSON.stringify({ ...planned, applied: false, request: plan }, null, 2);
    const out = new Out();
    for (const [field, value] of Object.entries(planned)) out.kv(field, value);
    return out.text('request', JSON.stringify(plan, null, 2)).kv('applied', false).list('help', ['Nothing was sent to Jira. Re-run the identical command with --yes to apply it.']).toString();
  }
  const readBack = `jira-axi issue ${a}`;
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
  try {
    const stored = find((await issueLinks(a, runtime)).links);
    if (!stored)
      throw new JiraError('Link applied, but read-back could not find it', 'bad_response');
    const applied = cleanModel({ ...planned, applied: true, linkId: stored.id, url: `${siteOrigin(runtime.env)}/browse/${a}` }, hidden);
    const out = new Out();
    for (const [field, value] of Object.entries(applied)) out.kv(field, value);
    const output = json ? JSON.stringify(applied, null, 2) : out.toString();
    assertNoSecrets(output, hidden);
    return output;
  }
  catch (error) {
    const failure = new JiraError('Link applied, but read-back or output failed', error instanceof JiraError ? error.code : 'transport_error', `Read back before retrying: ${readBack}`);
    failure.details.applied = true;
    throw failure;
  }
}

export async function restUnlink(args: Args, runtime: Runtime): Promise<string> {
  assertKnownFlags(args, UNLINK_FLAGS);
  const json = flagBool(args, 'json');
  const hidden = secrets(runtime.env);
  const id = args.positional[0];
  if (args.positional.length !== 1 || !id || !/^[1-9]\d{0,18}$/.test(id))
    throw new JiraError('unlink takes exactly one link id', 'usage', 'List ids with `jira-axi issue <KEY>`.');
  let raw: Record<string, unknown>;
  try {
    raw = object(await read(`/rest/api/3/issueLink/${id}`, new URLSearchParams(), runtime));
  }
  catch (error) {
    if (error instanceof JiraError && error.code === 'not_found')
      throw new JiraError(`Link ${id} does not exist`, 'not_found', 'If an earlier unlink of it reported applied: unknown, that delete succeeded. Nothing was sent.');
    throw error;
  }
  const type = parseLinkType(raw.type);
  const outward = object(raw.inwardIssue).key;
  const inward = object(raw.outwardIssue).key;
  if (raw.id !== id || typeof outward !== 'string' || !KEY_RE.test(outward) || typeof inward !== 'string' || !KEY_RE.test(inward))
    throw new JiraError('Malformed issue link', 'bad_response');
  const plan: PlannedDelete = { method: 'DELETE', path: `/rest/api/3/issueLink/${id}`, query: {} };
  assertNoSecrets(JSON.stringify(plan), hidden);
  const grant = confirmWrite(args, plan);
  const summary = cleanModel({ action: 'unlink-issues', payloadDigest: payloadDigest(plan), linkId: id, type: type.name, outward, inward, ...sentences(type, outward, inward) }, hidden);
  if (!grant) {
    if (json) return JSON.stringify({ ...summary, applied: false, request: plan }, null, 2);
    const out = new Out();
    for (const [field, value] of Object.entries(summary)) out.kv(field, value);
    return out.text('request', JSON.stringify(plan, null, 2)).kv('applied', false).list('help', ['Nothing was sent to Jira. Re-run the identical command with --yes to delete it.']).toString();
  }
  const readBack = `jira-axi unlink ${id}`;
  try {
    await remove(plan, grant, runtime);
  }
  catch (error) {
    if (!(error instanceof JiraError)) throw error;
    let replacement: JiraError | undefined;
    if (error.details.applied === 'unknown')
      replacement = new JiraError(error.message, error.code, `Read back before retrying: \`${readBack}\` previews without deleting; not_found there means the delete succeeded.`);
    else if (error.code === 'not_found')
      replacement = new JiraError(`Link ${id} was already deleted`, 'not_found');
    if (!replacement) throw error;
    replacement.details = error.details;
    throw replacement;
  }
  const applied = { ...summary, applied: true };
  const out = new Out();
  for (const [field, value] of Object.entries(applied)) out.kv(field, value);
  const output = json ? JSON.stringify(applied, null, 2) : out.toString();
  try {
    assertNoSecrets(output, hidden);
  }
  catch {
    const error = new JiraError('Unlink applied, but output was refused', 'security', `Confirm with \`${readBack}\`: not_found means it is gone.`);
    error.details.applied = true;
    throw error;
  }
  return output;
}
