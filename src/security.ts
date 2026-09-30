// Security contract ported from confluence-axi@ca3ca1f.
import { JiraError } from './jira.ts';
export type Env = Record<string, string | undefined>;
export function secrets(env: Env): string[] {
  const token = env.ATLASSIAN_API_TOKEN;
  const tokens = token ? [token] : [];
  if (env.ATLASSIAN_EMAIL && token)
    tokens.push(Buffer.from(env.ATLASSIAN_EMAIL + ':' + token).toString('base64'));
  return tokens.sort((a, b) => b.length - a.length);
}
export function redact(value: string, hidden: string[]): string {
  for (const secret of hidden)
    value = value.split(secret).join('[redacted]');
  return value;
}
export function sanitize(value: string, body = false): string {
  return value
    .replace(/(?:\x1b\[|\u009b)[0-?]*[ -/]*[@-~]/g, '')
    .replace(/(?:\x1b\]|\u009d)[\s\S]*?(?:\x07|\x1b\\|\u009c)/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '')
    .replace(/[\n\t]/g, body ? '$&' : ' ');
}
export function clean(value: string, hidden: string[], body = false): string {
  return redact(sanitize(redact(value, hidden), body), hidden);
}
export function missingConfig(): JiraError {
  return new JiraError('Require ATLASSIAN_EMAIL, ATLASSIAN_API_TOKEN and ATLASSIAN_SITE', 'token_missing', 'Set them as described in the README Setup section; create a token at https://id.atlassian.com/manage-profile/security/api-tokens');
}
export function credentials(env: Env): string {
  const email = env.ATLASSIAN_EMAIL;
  const token = env.ATLASSIAN_API_TOKEN;
  if (!email || !token)
    throw missingConfig();
  if (/[\x00-\x1f\x7f-\x9f:]/.test(email) || /[\x00-\x1f\x7f-\x9f]/.test(token))
    throw new JiraError('Invalid credential characters', 'security');
  return Buffer.from(email + ':' + token).toString('base64');
}
export function cleanModel<T>(value: T, hidden: string[], body = false): T {
  if (typeof value === 'string')
    return clean(value, hidden, body) as T;
  if (Array.isArray(value))
    return value.map(v => cleanModel(v, hidden, body)) as T;
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, cleanModel(v, hidden, k === 'description' || k === 'body' || k === 'bodyPreview')])) as T;
  return value;
}
export function assertOutboundText(field: string, value: string, body = false): void {
  const match = (body ? /[\x00-\x08\x0b-\x1f\x7f-\x9f]/ : /[\x00-\x1f\x7f-\x9f]/).exec(value);
  if (!match) return;
  const point = 'U+' + match[0].charCodeAt(0).toString(16).toUpperCase().padStart(4, '0');
  const error = new JiraError(`${field} contains terminal control ${point}`, 'security', `Strip control characters from ${field} (${point}) and re-run.`);
  error.details.applied = false;
  throw error;
}
export function assertNoSecrets(value: string, hidden: string[]): void {
  if (hidden.some(s => value.includes(s) || sanitize(value, true).includes(s)))
    throw new JiraError('Secret detected in serialized output or request', 'security');
}
