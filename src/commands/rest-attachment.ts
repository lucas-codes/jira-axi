import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { assertKnownFlags, flagBool, flagStr, type Args } from '../args.ts';
import { ATTACHMENT_CAP, read, readBytes, upload } from '../api.ts';
import { Out } from '../format.ts';
import { JiraError } from '../jira.ts';
import { object, projectKey, type Runtime } from '../rest.ts';
import { assertNoSecrets, assertOutboundText, cleanModel, secrets } from '../security.ts';
import { siteOrigin } from '../site.ts';
import { confirmWrite, payloadDigest, type PlannedUpload } from '../write-plan.ts';
import { issueShape, requireRestKey } from './rest-read.ts';

export const ATTACHMENTS_FLAGS = ['json', 'project', 'p'];
export const ATTACH_FLAGS = ['file', 'F', 'name', 'yes', 'confirm', 'json', 'project', 'p'];
export const DOWNLOAD_FLAGS = ['name', 'out', 'force', 'json', 'project', 'p'];

const ID_RE = /^[1-9]\d{0,18}$/;
const MIME: Record<string, string> = { '.md': 'text/markdown', '.txt': 'text/plain' };

interface Attachment {
  id: string;
  filename: string;
  size: number;
  mimeType: string;
  created: string;
  author: string | undefined;
}

// Jira documents id as both string and number and created as both ISO text and epoch millis; accept both, emit one form.
function parseAttachment(raw: unknown): Attachment {
  const a = object(raw);
  const id = typeof a.id === 'number' ? String(a.id) : a.id;
  const created = typeof a.created === 'number' || typeof a.created === 'string' ? new Date(a.created) : undefined;
  if (typeof id !== 'string' || !ID_RE.test(id) || typeof a.filename !== 'string' || !a.filename || !Number.isSafeInteger(a.size) || (a.size as number) < 0 || (a.mimeType != null && typeof a.mimeType !== 'string') || !created || Number.isNaN(created.getTime()))
    throw new JiraError('Malformed attachment', 'bad_response');
  const author = a.author == null ? undefined : object(a.author).displayName;
  return { id, filename: a.filename, size: a.size as number, mimeType: (a.mimeType as string | undefined) ?? '', created: created.toISOString(), author: typeof author === 'string' ? author : undefined };
}

async function issueAttachments(key: string, fields: string, runtime: Runtime): Promise<{ summary: string | undefined; list: Attachment[] }> {
  const raw = issueShape(await read(`/rest/api/3/issue/${key}`, new URLSearchParams({ fields }), runtime));
  if (raw.key !== key)
    throw new JiraError(`Issue moved to ${raw.key}`, 'issue_moved');
  const f = object(raw.fields);
  if (f.attachment != null && !Array.isArray(f.attachment))
    throw new JiraError('Malformed attachment list', 'bad_response');
  const list = ((f.attachment ?? []) as unknown[]).map(parseAttachment);
  // Newest first; ids break ties because Jira allocates them in upload order.
  list.sort((a, b) => b.created.localeCompare(a.created) || Number(BigInt(b.id) - BigInt(a.id)));
  return { summary: typeof f.summary === 'string' ? f.summary : undefined, list };
}

function onlyKey(args: Args, command: string, runtime: Runtime): string {
  if (args.positional.length !== 1)
    throw new JiraError(`${command} takes exactly one issue key`, 'usage');
  return requireRestKey(args.positional[0], projectKey(args, runtime.env));
}

export async function restAttachments(args: Args, runtime: Runtime): Promise<string> {
  assertKnownFlags(args, ATTACHMENTS_FLAGS);
  const key = onlyKey(args, 'attachments', runtime);
  const { list } = await issueAttachments(key, 'attachment', runtime);
  const rows = cleanModel(list, secrets(runtime.env));
  if (flagBool(args, 'json'))
    return JSON.stringify({ issue: key, count: rows.length, attachments: rows }, null, 2);
  return new Out()
    .kv('issue', key)
    .table('attachments', ['id', 'filename', 'size', 'mimeType', 'created', 'author'], rows.map(a => [a.id, a.filename, a.size, a.mimeType, a.created, a.author ?? '-']))
    .list('help', [`Run \`jira-axi download ${key} --name <filename> --out <path>\` for the newest file with that name`])
    .toString();
}

function assertFilename(name: string): void {
  assertOutboundText('filename', name);
  if (!name || name === '.' || name === '..' || /[/\\]/.test(name) || Buffer.byteLength(name) > 255)
    throw new JiraError('filename must be a bare name of 1-255 bytes without path separators', 'usage');
}

export async function restAttach(args: Args, runtime: Runtime): Promise<string> {
  const json = flagBool(args, 'json');
  const hidden = secrets(runtime.env);
  assertKnownFlags(args, ATTACH_FLAGS);
  const file = flagStr(args, 'file', 'F');
  if (!file || file === '-')
    throw new JiraError('attach requires --file <path>', 'usage', 'stdin is not accepted: a file path keeps the bytes exact.');
  const filename = flagStr(args, 'name') ?? basename(file);
  assertFilename(filename);
  const key = onlyKey(args, 'attach', runtime);
  const bytes = readFileSync(file);
  if (!bytes.length)
    throw new JiraError('file is empty', 'usage');
  if (bytes.length > ATTACHMENT_CAP)
    throw new JiraError(`file is ${bytes.length} bytes; the limit is 10 MiB`, 'file_too_large');
  assertNoSecrets(bytes.toString('latin1'), hidden);

  const { summary, list } = await issueAttachments(key, 'summary,attachment', runtime);
  const meta = object(await read('/rest/api/3/attachment/meta', new URLSearchParams(), runtime));
  if (typeof meta.enabled !== 'boolean' || !Number.isSafeInteger(meta.uploadLimit))
    throw new JiraError('Malformed attachment settings', 'bad_response');
  if (!meta.enabled)
    throw new JiraError('Attachments are disabled on this site', 'attachments_disabled');
  if (bytes.length > (meta.uploadLimit as number))
    throw new JiraError(`file is ${bytes.length} bytes; this site allows ${meta.uploadLimit}`, 'file_too_large');

  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const plan: PlannedUpload = { method: 'POST', path: `/rest/api/3/issue/${key}/attachments`, query: {}, upload: { filename, size: bytes.length, sha256, mimeType: MIME[extname(filename).toLowerCase()] ?? 'application/octet-stream' } };
  assertNoSecrets(JSON.stringify(plan), hidden);
  const grant = confirmWrite(args, plan);
  const existing = list.filter(a => a.filename === filename).length;
  if (!grant) {
    const preview = { ...cleanModel({ action: 'attach-file', applied: false, payloadDigest: payloadDigest(plan), issue: key, ...(summary ? { target: summary } : {}), ...plan.upload, existing }, hidden), request: plan };
    if (json)
      return JSON.stringify(preview, null, 2);
    return new Out()
      .kv('action', preview.action).kv('payloadDigest', preview.payloadDigest).kv('issue', key).kvIf('target', preview.target)
      .kv('filename', preview.filename).kv('size', preview.size).kv('sha256', sha256).kv('mimeType', preview.mimeType).kv('existing', existing)
      .text('request', JSON.stringify(plan, null, 2)).kv('applied', false)
      .list('help', ['Nothing was sent to Jira. Re-run the identical command with --yes to apply it.'])
      .toString();
  }

  const readBack = `jira-axi attachments ${key}`;
  let result: unknown;
  try {
    result = await upload(plan, grant, bytes, runtime);
  }
  catch (error) {
    if (error instanceof JiraError && error.details.applied === 'unknown') {
      const replacement = new JiraError(error.message, error.code, `Read back before retrying: ${readBack}. POSTs are not safe to retry automatically.`);
      replacement.details = error.details;
      throw replacement;
    }
    throw error;
  }
  // The upload is acknowledged from here on: any failure must say so rather than look like an unapplied write.
  const acknowledged = (error: JiraError) => {
    error.details.applied = true;
    return error;
  };
  let stored: Attachment;
  try {
    stored = parseAttachment((result as unknown[])[0]);
  }
  catch {
    throw acknowledged(new JiraError('Upload applied, but the response was malformed', 'bad_response', `Read back before retrying: ${readBack}`));
  }
  if (stored.size !== bytes.length)
    throw acknowledged(new JiraError(`Jira stored ${stored.size} bytes but ${bytes.length} were sent`, 'attachment_mismatch', `Inspect it with ${readBack}`));
  const applied = cleanModel({ action: 'attach-file', applied: true, payloadDigest: payloadDigest(plan), issue: key, attachmentId: stored.id, filename: stored.filename, size: stored.size, sha256, url: `${siteOrigin(runtime.env)}/browse/${key}` }, hidden);
  const out = new Out();
  for (const [field, value] of Object.entries(applied))
    out.kv(field, value as string | boolean | number);
  const output = json ? JSON.stringify(applied, null, 2) : out.toString();
  try {
    assertNoSecrets(output, hidden);
  }
  catch {
    throw acknowledged(new JiraError('Upload applied, but output was refused', 'security', `Read back before retrying: ${readBack}`));
  }
  return output;
}

// stdout is an agent's transcript, so raw bytes go there only when they are clean UTF-8 text; anything else needs --out <path>.
function assertSafeText(bytes: Buffer, hidden: string[]): void {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  }
  catch {
    throw new JiraError('Attachment is not UTF-8 text', 'security', 'Write it to a file with --out <path>.');
  }
  const match = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]|\r(?!\n)/.exec(text);
  if (match)
    throw new JiraError(`Attachment contains terminal control U+${match[0].charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`, 'security', 'Write it to a file with --out <path>.');
  assertNoSecrets(text, hidden);
}

function writeAtomically(path: string, bytes: Buffer): void {
  const temp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`);
  writeFileSync(temp, bytes, { flag: 'wx' });
  try {
    renameSync(temp, path);
  }
  catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

export async function restDownload(args: Args, runtime: Runtime): Promise<string | Uint8Array> {
  const json = flagBool(args, 'json');
  const hidden = secrets(runtime.env);
  assertKnownFlags(args, DOWNLOAD_FLAGS);
  const out = flagStr(args, 'out');
  const name = flagStr(args, 'name');
  if (args.positional.length !== 1 || !out)
    throw new JiraError('download takes an attachment id, or an issue key with --name, and requires --out <path|->', 'usage');
  if (out === '-' && json)
    throw new JiraError('--json cannot be combined with --out -', 'usage');
  const target = args.positional[0]!;
  const byId = /^\d+$/.test(target);
  if (byId === (name !== undefined))
    throw new JiraError(byId ? 'An attachment id does not take --name' : 'An issue key needs --name <filename>', 'usage');
  if (byId && !ID_RE.test(target))
    throw new JiraError('Invalid attachment id', 'usage');
  if (out !== '-' && !flagBool(args, 'force') && existsSync(out))
    throw new JiraError(`${out} already exists`, 'file_exists', 'Pass --force to replace it.');

  let attachment: Attachment;
  let issue: string | undefined;
  if (byId)
    attachment = parseAttachment(await read(`/rest/api/3/attachment/${target}`, new URLSearchParams(), runtime));
  else {
    issue = requireRestKey(target, projectKey(args, runtime.env));
    const { list } = await issueAttachments(issue, 'attachment', runtime);
    const match = list.find(a => a.filename === name);
    if (!match) {
      const names = [...new Set(list.map(a => a.filename))].slice(0, 10);
      throw new JiraError(`${issue} has no attachment named ${JSON.stringify(name)}`, 'not_found', `Attachments: ${names.length ? names.map(n => JSON.stringify(n)).join(', ') : 'none'} (names match exactly, case-sensitively).`);
    }
    attachment = match;
  }
  if (attachment.size > ATTACHMENT_CAP)
    throw new JiraError(`Attachment is ${attachment.size} bytes; the limit is 10 MiB`, 'response_too_large');
  const bytes = await readBytes(`/rest/api/3/attachment/content/${attachment.id}`, new URLSearchParams({ redirect: 'false' }), runtime);
  // Jira publishes no checksum, so the advertised size is the only integrity check available.
  if (bytes.length !== attachment.size)
    throw new JiraError(`Received ${bytes.length} bytes but the attachment is ${attachment.size}`, 'size_mismatch', 'Nothing was written. Retry the download.');
  if (out === '-') {
    assertSafeText(bytes, hidden);
    return bytes;
  }
  writeAtomically(out, bytes);
  const summary = cleanModel({ action: 'download-attachment', id: attachment.id, ...(issue ? { issue } : {}), filename: attachment.filename, size: bytes.length, mimeType: attachment.mimeType, sha256: createHash('sha256').update(bytes).digest('hex'), out }, hidden);
  if (json)
    return JSON.stringify(summary, null, 2);
  const lines = new Out();
  for (const [field, value] of Object.entries(summary))
    lines.kv(field, value as string | number);
  return lines.toString();
}
