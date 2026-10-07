// Transport contract ported from confluence-axi@ca3ca1f.
import { JiraError } from './jira.ts';
import { siteOrigin } from './site.ts';
import { credentials, clean, secrets, assertNoSecrets, type Env } from './security.ts';
import { createHash } from 'node:crypto';
import { assertGrant, type PlannedJsonWrite, type PlannedUpload, type PlannedWrite, type WriteGrant } from './write-plan.ts';
export interface ApiRuntime {
  env: Env;
  fetch: typeof globalThis.fetch;
}
export type ReadPath = `/rest/api/3/${string}` | `/rest/agile/1.0/${string}`;
const key = '[A-Z][A-Z0-9_]{1,9}-[1-9]\\d{0,9}';
const routes: [
  string,
  RegExp,
  string[]
][] = [
  ['GET', /^\/rest\/api\/3\/myself$/, []],
  ['GET', new RegExp(`^/rest/api/3/issue/${key}$`), ['fields']],
  ['GET', new RegExp(`^/rest/api/3/issue/${key}/comment$`), ['orderBy', 'maxResults', 'startAt']],
  ['GET', new RegExp(`^/rest/api/3/issue/${key}/transitions$`), ['expand']],
  ['GET', /^\/rest\/api\/3\/search\/jql$/, ['jql', 'maxResults', 'fields']],
  ['GET', /^\/rest\/api\/3\/user\/assignable\/search$/, ['query', 'project', 'issueKey', 'maxResults']],
  ['GET', /^\/rest\/api\/3\/attachment\/meta$/, []],
  ['GET', /^\/rest\/api\/3\/attachment\/[1-9]\d{0,18}$/, []],
  ['GET', /^\/rest\/api\/3\/attachment\/content\/[1-9]\d{0,18}$/, ['redirect']],
  ['GET', /^\/rest\/agile\/1\.0\/board\/[1-9]\d*$/, []],
  ['GET', /^\/rest\/agile\/1\.0\/board\/[1-9]\d*\/sprint$/, ['state', 'maxResults', 'startAt']],
  ['POST', /^\/rest\/api\/3\/issue$/, []],
  ['POST', new RegExp(`^/rest/api/3/issue/${key}/comment$`), []],
  ['POST', new RegExp(`^/rest/api/3/issue/${key}/transitions$`), []],
  ['POST', new RegExp(`^/rest/api/3/issue/${key}/attachments$`), []],
  ['PUT', new RegExp(`^/rest/api/3/issue/${key}$`), ['notifyUsers']],
];
const isTransition = (path: string) => path.endsWith('/transitions');
const isUpload = (path: string) => path.endsWith('/attachments');
// Transitions and edits answer 204 with no body; attachment upload answers 200; every other POST creates with 201.
const writeStatus = (method: string, path: string) => method === 'PUT' || isTransition(path) ? 204 : isUpload(path) ? 200 : 201;
const JSON_CAP = 5 * 1024 * 1024;
export const ATTACHMENT_CAP = 10 * 1024 * 1024;
export function validateUrl(method: string, input: string, origin: string): URL {
  const refuse = () => {
    throw new JiraError('Disallowed request URL', 'security');
  };
  if (input !== input.trim() || /[\x00-\x20\x7f-\x9f]/.test(input) || /^(?:[a-z][a-z\d+.-]*:)?\/\/[^/]*@/i.test(input))
    refuse();
  let url: URL;
  try {
    url = new URL(input, origin);
  }
  catch {
    return refuse();
  }
  const row = routes.find(([m, p]) => m === method && p.test(url.pathname));
  if (url.origin !== origin || url.protocol !== 'https:' || (url.port && url.port !== '443') || url.username || url.password || url.href.includes('#') || !row)
    refuse();
  for (const [k, v] of url.searchParams)
    // Following the content endpoint's default 303 would leave the site origin, so only redirect=false is allowed.
    if (!row![2].includes(k) || ((method === 'PUT' || k === 'redirect') && v !== 'false'))
      refuse();
  return url;
}
type Payload = { json: unknown } | { form: FormData };
async function readCapped(response: Response, cap: number, controller: AbortController, message: string): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader)
    return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done)
        break;
      size += value.byteLength;
      if (size > cap)
        throw new JiraError(message, 'response_too_large');
      chunks.push(value);
    }
  }
  finally {
    if (size > cap) {
      controller.abort();
      await reader.cancel();
    }
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}
async function send(method: string, input: string, runtime: ApiRuntime, payload?: Payload, binary = false): Promise<unknown> {
  const url = validateUrl(method, input, siteOrigin(runtime.env));
  const basic = credentials(runtime.env);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new JiraError('Request deadline exceeded', 'transport_error'));
    }, 30000);
  });
  const work = async () => {
    const headers: Record<string, string> = { Authorization: 'Basic ' + basic, Accept: binary ? '*/*' : 'application/json' };
    let body: string | FormData | undefined;
    if (payload && 'form' in payload) {
      // fetch sets the multipart Content-Type with its boundary; Jira blocks uploads without this header.
      headers['X-Atlassian-Token'] = 'no-check';
      body = payload.form;
    }
    else if (payload) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(payload.json);
    }
    const response = await runtime.fetch(url.href, { method, redirect: 'manual', headers, signal: controller.signal, ...(body === undefined ? {} : { body }) });
    if (response.status >= 300 && response.status < 400)
      throw new JiraError('Redirect refused', 'security');
    if (!response.ok && response.status !== 400) {
      const code = ({ 401: 'unauthorized', 403: 'forbidden', 404: 'not_found', 413: 'payload_too_large', 429: 'rate_limited' } as Record<number, string>)[response.status] ?? 'http_error';
      const error = new JiraError(`HTTP request failed (${response.status})`, code);
      if (response.status === 429) {
        const retry = response.headers.get('Retry-After');
        if (retry && /^\d+$/.test(retry) && Number(retry) <= 86400)
          error.details.retryAfter = Number(retry);
        const reason = response.headers.get('RateLimit-Reason');
        if (reason)
          error.details.limitReason = Array.from(clean(reason, secrets(runtime.env))).slice(0, 64).join('');
      }
      throw error;
    }
    if (method !== 'GET' && response.ok && response.status !== writeStatus(method, url.pathname))
      throw new JiraError('Unexpected write response', 'write_outcome_unknown');
    if (response.status === 204)
      return null;
    if (binary && response.status === 200)
      return await readCapped(response, ATTACHMENT_CAP, controller, 'Attachment exceeds 10 MiB');
    if (binary && response.ok)
      throw new JiraError('Unexpected attachment response', 'bad_response');
    const rejected = new JiraError('Jira rejected the request', 'rejected');
    let data: unknown;
    try {
      if (!/^application\/(?:[\w.+-]*\+)?json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? ''))
        throw new JiraError('Expected JSON response', 'bad_json');
      if (!response.body)
        throw new JiraError('Empty response', 'bad_json');
      const raw = await readCapped(response, JSON_CAP, controller, 'Response exceeds 5 MiB; lower --limit');
      try {
        data = JSON.parse(raw.toString('utf8'));
      }
      catch {
        throw new JiraError('Invalid JSON response', 'bad_json');
      }
    }
    catch (error) {
      if (response.status === 400 && error instanceof JiraError && error.code === 'bad_json')
        throw rejected;
      throw error;
    }
    if (response.status === 400) {
      const r = data && typeof data === 'object' ? data as Record<string, unknown> : {};
      const bounded = (s: string) => Array.from(clean(s, secrets(runtime.env))).slice(0, 200).join('');
      rejected.details.errorMessages = Array.isArray(r.errorMessages) ? r.errorMessages.filter((s): s is string => typeof s === 'string').slice(0, 10).map(bounded) : [];
      rejected.details.fields = r.errors && typeof r.errors === 'object' && !Array.isArray(r.errors) ? Object.entries(r.errors).filter((e): e is [
        string,
        string
      ] => typeof e[1] === 'string').slice(0, 10).map(([field, message]) => ({ field: bounded(field), message: bounded(message) })) : [];
      const board = /\/board\/(\d+)\/sprint$/.exec(url.pathname)?.[1];
      if (board && rejected.details.errorMessages.some(s => /does not support sprints/i.test(s)))
        throw new JiraError(`board ${board} does not support sprints`, 'unsupported');
      throw rejected;
    }
    return data;
  };
  try {
    return await Promise.race([work(), deadline]);
  }
  catch (error) {
    if (error instanceof JiraError)
      throw error;
    throw new JiraError('Request failed', 'transport_error');
  }
  finally {
    clearTimeout(timer);
    controller.abort();
  }
}
async function apply(plan: PlannedWrite, grant: WriteGrant, runtime: ApiRuntime, bytes?: Buffer): Promise<unknown | null> {
  let sending = false;
  try {
    assertGrant(plan, grant);
    const input = plan.path + (Object.keys(plan.query).length ? '?' + new URLSearchParams(plan.query).toString() : '');
    validateUrl(plan.method, input, siteOrigin(runtime.env));
    credentials(runtime.env);
    assertNoSecrets(JSON.stringify(plan), secrets(runtime.env));
    let payload: Payload;
    if ('upload' in plan) {
      const { filename, size, sha256, mimeType } = plan.upload;
      if (!bytes || bytes.length !== size || createHash('sha256').update(bytes).digest('hex') !== sha256)
        throw new JiraError('Upload bytes do not match the planned digest', 'security');
      // Secrets are ASCII, so a latin1 view finds them at the same bytes in text and binary content alike.
      assertNoSecrets(bytes.toString('latin1'), secrets(runtime.env));
      const form = new FormData();
      form.append('file', new Blob([bytes], { type: mimeType }), filename);
      payload = { form };
    }
    else
      payload = { json: plan.body };
    sending = true;
    const result = await send(plan.method, input, runtime, payload);
    if ('upload' in plan) {
      if (!Array.isArray(result) || result.length !== 1 || !result[0] || typeof result[0] !== 'object' || !['string', 'number'].includes(typeof result[0].id))
        throw new JiraError('Malformed write response', 'bad_response');
    }
    else if (plan.method === 'POST' && !isTransition(plan.path)) {
      if (!result || typeof result !== 'object' || Array.isArray(result))
        throw new JiraError('Malformed write response', 'bad_response');
      const r = result as Record<string, unknown>;
      if (typeof r.id !== 'string' || (plan.path === '/rest/api/3/issue' && typeof r.key !== 'string'))
        throw new JiraError('Malformed write response', 'bad_response');
    }
    return result;
  }
  catch (error) {
    const e = error instanceof JiraError ? error : new JiraError('Request failed', 'transport_error');
    if (!sending) {
      e.details.applied = false;
      throw e;
    }
    const rejected = ['unauthorized', 'forbidden', 'not_found', 'payload_too_large', 'rate_limited', 'rejected'].includes(e.code);
    if (rejected) {
      e.details.applied = false;
      throw e;
    }
    const unknown = new JiraError(e.code === 'security' ? e.message : 'Write outcome unknown', e.code === 'security' ? 'security' : 'write_outcome_unknown');
    unknown.details = { ...e.details, applied: 'unknown' };
    throw unknown;
  }
}
export function write(plan: PlannedJsonWrite, grant: WriteGrant, runtime: ApiRuntime): Promise<unknown | null> {
  return apply(plan, grant, runtime);
}
export function upload(plan: PlannedUpload, grant: WriteGrant, bytes: Buffer, runtime: ApiRuntime): Promise<unknown> {
  return apply(plan, grant, runtime, bytes);
}
export function read(path: ReadPath, query: URLSearchParams, runtime: ApiRuntime): Promise<unknown> {
  return send('GET', path + (query.size ? '?' + query.toString() : ''), runtime);
}
export async function readBytes(path: ReadPath, query: URLSearchParams, runtime: ApiRuntime): Promise<Buffer> {
  return await send('GET', path + (query.size ? '?' + query.toString() : ''), runtime, undefined, true) as Buffer;
}
