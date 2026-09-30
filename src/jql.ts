import { flagBool, flagList, flagStr, type Args } from './args.ts';
import { JiraError } from './jira.ts';
const quote = JSON.stringify;
function splitOrder(raw: string): [
  string,
  string | undefined
] {
  let quoted = '';
  let at = -1;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (c === '\\') {
      i++;
      continue;
    }
    if (quoted) {
      if (c === quoted)
        quoted = '';
      continue;
    }
    if (c === '"' || c === "'") {
      quoted = c;
      continue;
    }
    if ((i === 0 || /\s/.test(raw[i - 1]!)) && /^ORDER\s+BY\b/i.test(raw.slice(i)))
      at = i;
  }
  return at < 0 ? [raw.trim(), undefined] : [raw.slice(0, at).trim(), raw.slice(at).trim()];
}
function dateClauses(field: string, value: string): string[] {
  const keyword = ({ today: 'Day', week: 'Week', month: 'Month', year: 'Year' } as Record<string, string>)[value];
  if (keyword)
    return [`${field}>=startOf${keyword}()`];
  const out = [`${field}>=${quote(value)}`];
  const match = /^(\d{4})([-/])(\d{2})\2(\d{2})(?: (\d{2}):(\d{2}))?$/.exec(value);
  if (match) {
    const [, y, sep, m, d, h, min] = match;
    const dt = new Date(0);
    dt.setUTCFullYear(Number(y), Number(m) - 1, Number(d));
    if (dt.getUTCFullYear() === Number(y) && dt.getUTCMonth() === Number(m) - 1 && dt.getUTCDate() === Number(d) && (!h || (Number(h) <= 12 && Number(min) < 60))) {
      dt.setUTCDate(dt.getUTCDate() + 1);
      const next = [String(dt.getUTCFullYear()).padStart(4, '0'), String(dt.getUTCMonth() + 1).padStart(2, '0'), String(dt.getUTCDate()).padStart(2, '0')].join(sep) + (h ? ` ${h}:${min}` : '');
      out.push(`${field}<${quote(next)}`);
    }
  }
  return out;
}
export function buildJql(args: Args, project: string | undefined, sprint?: number, parent?: string): string {
  const [raw, order] = splitOrder(flagStr(args, 'jql', 'q') ?? '');
  // Retain the loose project detector for existing query compatibility.
  const hasProject = /((project)[\s]*?={0,1}\b)[^'.']/i.test(raw);
  if (!hasProject && !project)
    throw new JiraError('This command needs a project; pass --project or set JIRA_PROJECT', 'usage');
  const clauses: string[] = hasProject ? [] : [`project=${quote(project)}`];
  if (raw)
    clauses.push(`(${raw})`);
  if (flagBool(args, 'history'))
    clauses.push('issue IN issueHistory()');
  if (flagBool(args, 'watching'))
    clauses.push('issue IN watchedIssues()');
  for (const [field, names] of [['type', ['type', 't']], ['priority', ['priority', 'y']], ['assignee', ['assignee', 'a']], ['parent', ['parent', 'P']]] as [
    string,
    string[]
  ][]) {
    let value = field === 'parent' ? parent : flagStr(args, ...names);
    if (field === 'assignee' && (value === 'me' || flagBool(args, 'mine'))) {
      clauses.push('assignee = currentUser()');
      continue;
    }
    if (!value)
      continue;
    if (value === 'x')
      clauses.push(`${field} IS EMPTY`);
    else if (value === '~x')
      clauses.push(`${field} IS NOT EMPTY`);
    else if (value.startsWith('~'))
      clauses.push(`${field}!=${quote(value.slice(1).trimStart())}`);
    else
      clauses.push(`${field}=${quote(value)}`);
  }
  for (const field of ['created', 'updated']) {
    const value = flagStr(args, field);
    if (value)
      clauses.push(...dateClauses(field + 'Date', value));
  }
  for (const [field, names] of [['labels', ['label', 'l']], ['status', ['status', 's']]] as [
    string,
    string[]
  ][]) {
    const values = flagList(args, ...names);
    for (const negative of [false, true]) {
      const subset = values.filter(s => s.startsWith('~') === negative).map(s => negative ? s.slice(1) : s);
      if (subset.length)
        clauses.push(`${field} ${negative ? 'NOT IN' : 'IN'} (${subset.map(s => quote(s)).join(', ')})`);
    }
  }
  const text = args.positional.join(' ');
  if (text)
    clauses.push(`text ~ ${quote(text)}`);
  if (sprint !== undefined)
    clauses.push(`sprint = ${sprint}`);
  const defaultOrder = flagBool(args, 'history') ? 'lastViewed' : flagStr(args, 'updated') && !flagStr(args, 'created') ? 'updated' : 'created';
  return clauses.join(' AND ') + ' ' + (order ?? `ORDER BY ${defaultOrder} DESC`);
}
