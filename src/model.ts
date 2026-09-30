/**
 * Normalizes the two different JSON shapes the `jira` CLI emits with `--raw`.
 *
 *  - `jira issue view KEY --raw` proxies the raw Jira Cloud v3 API response:
 *    `{ key, fields: { issuetype, status, ..., customfield_XXXXX } }`.
 *  - `jira issue list --raw` emits the CLI's own struct marshalling:
 *    `[{ key, fields: { issueType, Subtasks, issueLinks, ... } }]` — same
 *    data, different key spellings, no custom fields.
 *
 * Both are accepted here so a single renderer covers both paths.
 */

import { adfToText } from './adf.ts';

export interface Person {
  name: string;
  email?: string;
}

export interface Comment {
  id?: string;
  author: string;
  created: string;
  updated?: string;
  body: string;
}

export interface IssueLink {
  type: string;
  key: string;
  summary?: string;
  status?: string;
}

export interface Issue {
  key: string;
  summary: string;
  type: string;
  status: string;
  statusCategory?: string;
  priority?: string;
  resolution?: string;
  assignee?: string;
  reporter?: string;
  labels: string[];
  components: string[];
  fixVersions: string[];
  parent?: { key: string; summary?: string };
  epic?: string;
  sprint?: string;
  sprintState?: string;
  estimate?: string;
  created?: string;
  updated?: string;
  due?: string;
  description: string;
  comments: Comment[];
  commentTotal: number;
  subtasks: IssueLink[];
  links: IssueLink[];
  url?: string;
}

type Rec = Record<string, unknown>;

function rec(v: unknown): Rec | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined;
}

function str(v: unknown): string | undefined {
  if (typeof v === 'string') return v === '' ? undefined : v;
  if (typeof v === 'number') return String(v);
  return undefined;
}

function named(v: unknown): string | undefined {
  const r = rec(v);
  if (!r) return str(v);
  return str(r['name']) ?? str(r['displayName']) ?? str(r['value']);
}

function namedList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map(named).filter((x): x is string => Boolean(x));
}

function stringList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string' && x !== '');
}

function pick(f: Rec, ...keys: string[]): unknown {
  for (const k of keys) {
    if (f[k] != null) return f[k];
  }
  return undefined;
}

function date(v: unknown): string | undefined {
  const s = str(v);
  if (!s) return undefined;
  return s.slice(0, 10);
}

/** Sprint lives in an instance-specific custom field; find it by shape. */
function findSprint(f: Rec): { name?: string; state?: string } {
  for (const [k, v] of Object.entries(f)) {
    if (!k.startsWith('customfield_') || !Array.isArray(v)) continue;
    const entries = v.map(rec).filter((x): x is Rec => Boolean(x));
    if (entries.length === 0) continue;
    if (!entries.every((e) => 'boardId' in e || ('state' in e && 'name' in e))) continue;
    const active = entries.find((e) => e['state'] === 'active') ?? entries[entries.length - 1];
    if (!active) continue;
    return { name: str(active['name']), state: str(active['state']) };
  }
  return {};
}

/** Epic link is a configurable custom field; accept the common spellings. */
function findEpic(f: Rec, epicLinkField?: string): string | undefined {
  if (epicLinkField && typeof f[epicLinkField] === 'string') return f[epicLinkField] as string;
  const direct = str(pick(f, 'epic', 'Epic'));
  if (direct) return direct;
  for (const [k, v] of Object.entries(f)) {
    if (!k.startsWith('customfield_')) continue;
    if (typeof v === 'string' && /^[A-Z][A-Z0-9_]+-\d+$/.test(v)) return v;
  }
  return undefined;
}

function seconds(v: unknown): string | undefined {
  if (typeof v !== 'number' || v <= 0) return undefined;
  const h = v / 3600;
  return h >= 1 ? `${Number(h.toFixed(2))}h` : `${Math.round(v / 60)}m`;
}

function parseComments(v: unknown): { comments: Comment[]; total: number } {
  const r = rec(v);
  if (!r) return { comments: [], total: 0 };
  const raw = Array.isArray(r['comments']) ? (r['comments'] as unknown[]) : [];
  const comments = raw.map(rec).filter((c): c is Rec => Boolean(c)).map((c) => ({
    id: str(c['id']),
    author: named(c['author']) ?? 'unknown',
    created: date(c['created']) ?? '',
    updated: date(c['updated']),
    body: adfToText(c['body']),
  }));
  const total = typeof r['total'] === 'number' ? (r['total'] as number) : comments.length;
  return { comments, total };
}

function parseLinks(v: unknown): IssueLink[] {
  if (!Array.isArray(v)) return [];
  const out: IssueLink[] = [];
  for (const raw of v) {
    const l = rec(raw);
    if (!l) continue;
    const t = rec(l['type']);
    const inward = rec(l['inwardIssue']);
    const outward = rec(l['outwardIssue']);
    const other = inward ?? outward;
    if (!other) continue;
    const relation =
      (inward ? str(t?.['inward']) : str(t?.['outward'])) ?? named(l['type']) ?? 'relates to';
    const of = rec(other['fields']);
    out.push({
      type: relation,
      key: str(other['key']) ?? '?',
      summary: str(of?.['summary']),
      status: named(of?.['status']),
    });
  }
  return out;
}

function parseSubtasks(v: unknown): IssueLink[] {
  if (!Array.isArray(v)) return [];
  const out: IssueLink[] = [];
  for (const raw of v) {
    const s = rec(raw);
    if (!s) continue;
    const sf = rec(s['fields']);
    out.push({
      type: 'subtask',
      key: str(s['key']) ?? '?',
      summary: str(sf?.['summary']),
      status: named(sf?.['status']),
    });
  }
  return out;
}

export interface ParseOptions {
  /** Jira site base URL, used to build browse links. */
  baseUrl?: string;
  /** Epic-link custom field id from ~/.config/.jira/.config.yml, when known. */
  epicLinkField?: string;
  sprintField?: string;
  rest?: boolean;
}

export function parseIssue(input: unknown, opts: ParseOptions = {}): Issue {
  const root = rec(input);
  if (!root) throw new Error('unexpected jira output: not a JSON object');
  const f = rec(root['fields']) ?? {};
  const key = str(root['key']) ?? str(f['key']) ?? '?';
  const status = rec(pick(f, 'status'));
  const { comments, total } = parseComments(pick(f, 'comment', 'comments'));
  const sprintEntries = opts.rest && Array.isArray(f[opts.sprintField ?? 'customfield_10020']) ? (f[opts.sprintField ?? 'customfield_10020'] as unknown[]).map(rec).filter((s): s is Rec => !!s) : [];
  const selected = sprintEntries.find(s => s['state'] === 'active') ?? sprintEntries.at(-1);
  const sprint = opts.rest ? {name:str(selected?.['name']),state:str(selected?.['state'])} : findSprint(f);

  return {
    key,
    summary: str(f['summary']) ?? '',
    type: named(pick(f, 'issuetype', 'issueType', 'type')) ?? '?',
    status: named(status) ?? '?',
    statusCategory: named(rec(status?.['statusCategory'])),
    priority: named(f['priority']),
    resolution: named(f['resolution']),
    assignee: named(f['assignee']),
    reporter: named(f['reporter']),
    labels: stringList(f['labels']),
    components: namedList(f['components']),
    fixVersions: namedList(f['fixVersions']),
    parent: (() => {
      const p = rec(f['parent']);
      if (!p) return undefined;
      const k = str(p['key']);
      if (!k) return undefined;
      return { key: k, summary: str(rec(p['fields'])?.['summary']) };
    })(),
    epic: opts.rest ? str(f[opts.epicLinkField ?? 'customfield_10014']) : findEpic(f, opts.epicLinkField),
    sprint: sprint.name,
    sprintState: sprint.state,
    estimate: seconds(pick(f, 'timeoriginalestimate', 'timeestimate')),
    created: date(f['created']),
    updated: date(f['updated']),
    due: date(f['duedate']),
    description: adfToText(f['description']),
    comments,
    commentTotal: total,
    subtasks: parseSubtasks(pick(f, 'subtasks', 'Subtasks')),
    links: parseLinks(pick(f, 'issuelinks', 'issueLinks')),
    url: opts.baseUrl ? `${opts.baseUrl.replace(/\/$/, '')}/browse/${key}` : undefined,
  };
}

export function parseIssueList(input: unknown, opts: ParseOptions = {}): Issue[] {
  const arr = Array.isArray(input)
    ? input
    : Array.isArray(rec(input)?.['issues'])
      ? (rec(input)!['issues'] as unknown[])
      : [];
  return arr.map((i) => parseIssue(i, opts));
}

export interface Sprint {
  id?: string;
  name: string;
  state?: string;
  start?: string;
  end?: string;
}

export function parseSprints(input: unknown): Sprint[] {
  const arr = Array.isArray(input) ? input : [];
  const out: Sprint[] = [];
  for (const raw of arr) {
    const s = rec(raw);
    if (!s) continue;
    const name = str(s['name']);
    if (!name) continue;
    out.push({
      id: str(s['id']),
      name,
      state: str(s['state']),
      start: date(pick(s, 'startDate', 'start')),
      end: date(pick(s, 'endDate', 'end')),
    });
  }
  return out;
}
