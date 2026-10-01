// Transport contract ported from confluence-axi@ca3ca1f.
import { JiraError } from './jira.ts';
import { siteOrigin } from './site.ts';
import { credentials, clean, secrets, assertNoSecrets, type Env } from './security.ts';
import { assertGrant, type PlannedWrite, type WriteGrant } from './write-plan.ts';
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
  ['GET', /^\/rest\/agile\/1\.0\/board\/[1-9]\d*$/, []],
  ['GET', /^\/rest\/agile\/1\.0\/board\/[1-9]\d*\/sprint$/, ['state', 'maxResults', 'startAt']],
  ['POST', /^\/rest\/api\/3\/issue$/, []],
  ['POST', new RegExp(`^/rest/api/3/issue/${key}/comment$`), []],
  ['POST', new RegExp(`^/rest/api/3/issue/${key}/transitions$`), []],
  ['PUT', new RegExp(`^/rest/api/3/issue/${key}$`), ['notifyUsers']],
];
const isTransition = (path: string) => path.endsWith('/transitions');
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
    if (!row![2].includes(k) || (method === 'PUT' && v !== 'false'))
      refuse();
  return url;
}
async function send(method: string, input: string, runtime: ApiRuntime, body?: unknown): Promise<unknown> {
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
    const response = await runtime.fetch(url.href, { method, redirect: 'manual', headers: { Authorization: 'Basic ' + basic, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, signal: controller.signal, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (response.status >= 300 && response.status < 400)
      throw new JiraError('Redirect refused', 'security');
    if (!response.ok && response.status !== 400) {
      const code = ({ 401: 'unauthorized', 403: 'forbidden', 404: 'not_found', 429: 'rate_limited' } as Record<number, string>)[response.status] ?? 'http_error';
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
    // A transition POST is the one create-shaped write that answers 204 with no body.
    if (method !== 'GET' && response.ok && response.status !== (method === 'POST' && !isTransition(url.pathname) ? 201 : 204))
      throw new JiraError('Unexpected write response', 'write_outcome_unknown');
    if (response.status === 204)
      return null;
    const rejected = new JiraError('Jira rejected the request', 'rejected');
    let data: unknown;
    try {
      if (!/^application\/(?:[\w.+-]*\+)?json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? ''))
        throw new JiraError('Expected JSON response', 'bad_json');
      const reader = response.body?.getReader();
      if (!reader)
        throw new JiraError('Empty response', 'bad_json');
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done)
            break;
          size += value.byteLength;
          if (size > 5 * 1024 * 1024)
            throw new JiraError('Response exceeds 5 MiB; lower --limit', 'response_too_large');
          chunks.push(value);
        }
      }
      finally {
        if (size > 5 * 1024 * 1024) {
          controller.abort();
          await reader.cancel();
        }
        reader.releaseLock();
      }
      try {
        data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
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
export async function write(plan: PlannedWrite, grant: WriteGrant, runtime: ApiRuntime): Promise<unknown | null> {
  let sending = false;
  try {
    assertGrant(plan, grant);
    const input = plan.path + (Object.keys(plan.query).length ? '?' + new URLSearchParams(plan.query).toString() : '');
    validateUrl(plan.method, input, siteOrigin(runtime.env));
    credentials(runtime.env);
    assertNoSecrets(JSON.stringify(plan), secrets(runtime.env));
    sending = true;
    const result = await send(plan.method, input, runtime, plan.body);
    if (plan.method === 'POST' && !isTransition(plan.path)) {
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
    const rejected = ['unauthorized', 'forbidden', 'not_found', 'rate_limited', 'rejected'].includes(e.code);
    if (rejected) {
      e.details.applied = false;
      throw e;
    }
    const unknown = new JiraError(e.code === 'security' ? e.message : 'Write outcome unknown', e.code === 'security' ? 'security' : 'write_outcome_unknown');
    unknown.details = { ...e.details, applied: 'unknown' };
    throw unknown;
  }
}
export function read(path: ReadPath, query: URLSearchParams, runtime: ApiRuntime): Promise<unknown> {
  return send('GET', path + (query.size ? '?' + query.toString() : ''), runtime);
}
