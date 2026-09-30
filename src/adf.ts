/**
 * Atlassian Document Format (ADF) -> plain text.
 *
 * Jira Cloud's v3 REST API returns description and comment bodies as ADF
 * documents. `jira issue view --raw` passes those straight through. This
 * flattener renders them as compact plain text: no HTML, no markdown noise,
 * just the words an agent needs.
 *
 * Anything that is already a string (server Jira wiki markup, or a
 * pre-rendered body) is lightly de-marked-up instead.
 */

import { JiraError } from './jira.ts';

export function safeLink(value: unknown): value is string {
  if (typeof value !== 'string' || /[\x00-\x20\x7f-\x9f]/.test(value) || /^https?:\/\/[^/]*@/i.test(value)) return false;
  try { const url = new URL(value); return ['http:','https:'].includes(url.protocol) && !url.username && !url.password; } catch { return false; }
}

function validateAdf(body: unknown): asserts body is AdfNode {
  const fail = () => { throw new JiraError('Malformed or oversized ADF','bad_response'); };
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail();
  const root = body as Record<string,unknown>;
  if (root.type !== 'doc' || root.version !== 1 || !Array.isArray(root.content)) fail();
  const stack: [unknown,number][] = [[body,0]]; let count = 0;
  while (stack.length) {
    const [value,depth] = stack.pop()!;
    if (++count > 100000 || depth > 64 || !value || typeof value !== 'object' || Array.isArray(value)) fail();
    const n = value as Record<string,unknown>;
    if (typeof n.type !== 'string' || !n.type || (n.text !== undefined && typeof n.text !== 'string')) fail();
    if (n.attrs !== undefined && (!n.attrs || typeof n.attrs !== 'object' || Array.isArray(n.attrs))) fail();
    const attrs = (n.attrs ?? {}) as Record<string, unknown>;
    for (const key of ['href', 'url', 'text', 'shortName', 'language', 'alt', 'title', 'panelType', 'state', 'timestamp']) {
      if (attrs[key] !== undefined && typeof attrs[key] !== 'string') fail();
    }
    for (const key of ['level', 'order']) {
      if (attrs[key] !== undefined && (typeof attrs[key] !== 'number' || !Number.isSafeInteger(attrs[key]))) fail();
    }
    if (n.marks !== undefined) {
      if (!Array.isArray(n.marks)) fail();
      for (const mark of n.marks as unknown[]) {
        if (!mark || typeof mark !== 'object' || Array.isArray(mark)) fail();
        const m = mark as Record<string,unknown>;
        if (typeof m.type !== 'string' || (m.attrs !== undefined && (!m.attrs || typeof m.attrs !== 'object' || Array.isArray(m.attrs)))) fail();
        if (m.type === 'link' && typeof (m.attrs as Record<string, unknown> | undefined)?.['href'] !== 'string') fail();
      }
    }
    if (n.content !== undefined) {
      if (!Array.isArray(n.content)) fail();
      for (const child of n.content as unknown[]) stack.push([child,depth+1]);
    }
  }
}

export interface AdfNode {
  type?: string;
  text?: string;
  content?: AdfNode[];
  attrs?: Record<string, unknown>;
  marks?: { type?: string; attrs?: Record<string, unknown> }[];
}

const BULLET = '- ';

function trimTrailingBlanks(lines: string[]): string[] {
  const out = [...lines];
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out;
}

function markWrap(text: string, marks: AdfNode['marks']): string {
  if (!marks || marks.length === 0) return text;
  for (const m of marks) {
    if (m?.type === 'code') return '`' + text + '`';
  }
  for (const m of marks) {
    if (m?.type === 'link') {
      const href = m.attrs?.['href'];
      if (!safeLink(href)) return `${text} [link omitted]`;
      if (href !== text) return `${text} (${href})`;
    }
  }
  return text;
}

function inline(nodes: AdfNode[] | undefined): string {
  if (!nodes) return '';
  let out = '';
  for (const n of nodes) {
    out += inlineOne(n);
  }
  return out;
}

function inlineOne(n: AdfNode): string {
  switch (n.type) {
    case 'text':
      return markWrap(n.text ?? '', n.marks);
    case 'hardBreak':
      return '\n';
    case 'mention': {
      const t = n.attrs?.['text'];
      return typeof t === 'string' ? t : '@user';
    }
    case 'emoji': {
      const t = n.attrs?.['text'] ?? n.attrs?.['shortName'];
      return typeof t === 'string' ? t : '';
    }
    case 'inlineCard':
    case 'blockCard':
    case 'embedCard': {
      const url = n.attrs?.['url'];
      return safeLink(url) ? url : '[card omitted]';
    }
    case 'date': {
      const ts = n.attrs?.['timestamp'];
      if (typeof ts === 'string' && /^\d+$/.test(ts)) {
        return new Date(Number(ts)).toISOString().slice(0, 10);
      }
      return '';
    }
    case 'status': {
      const t = n.attrs?.['text'];
      return typeof t === 'string' ? `[${t}]` : '';
    }
    default:
      return n.content ? inline(n.content) : n.text ?? `[unsupported: ${n.type}]`;
  }
}

function block(n: AdfNode, depth: number, out: string[]): void {
  const indent = '  '.repeat(depth);
  switch (n.type) {
    case 'text':
    case 'inlineCard':
    case 'blockCard':
    case 'embedCard':
      out.push(indent + inlineOne(n));
      return;
    case 'doc':
      for (const c of n.content ?? []) block(c, depth, out);
      return;
    case 'paragraph': {
      const text = inline(n.content).trim();
      if (text) out.push(indent + text.replace(/\n/g, '\n' + indent));
      out.push('');
      return;
    }
    case 'heading': {
      const level = Number(n.attrs?.['level'] ?? 1);
      const text = inline(n.content).trim();
      if (text) out.push(indent + '#'.repeat(Math.min(6, Math.max(1, level))) + ' ' + text);
      out.push('');
      return;
    }
    case 'bulletList':
    case 'orderedList': {
      const ordered = n.type === 'orderedList';
      let i = Number(n.attrs?.['order'] ?? 1);
      for (const item of n.content ?? []) {
        const marker = ordered ? `${i++}. ` : BULLET;
        const sub: string[] = [];
        for (const c of item.content ?? []) block(c, 0, sub);
        const lines = trimTrailingBlanks(sub);
        const first = lines.shift() ?? '';
        out.push(indent + marker + first);
        for (const l of lines) out.push(indent + '  '.repeat(1) + '  ' + l);
      }
      return;
    }
    case 'taskList': {
      for (const item of n.content ?? []) {
        const done = item.attrs?.['state'] === 'DONE';
        out.push(`${indent}[${done ? 'x' : ' '}] ${inline(item.content).trim()}`);
      }
      return;
    }
    case 'codeBlock': {
      const lang = n.attrs?.['language'];
      out.push(indent + '```' + (typeof lang === 'string' ? lang : ''));
      for (const line of inline(n.content).split('\n')) out.push(indent + line);
      out.push(indent + '```');
      return;
    }
    case 'blockquote': {
      const sub: string[] = [];
      for (const c of n.content ?? []) block(c, 0, sub);
      for (const l of trimTrailingBlanks(sub)) out.push(indent + (l ? '> ' + l : '>'));
      return;
    }
    case 'panel': {
      const kind = n.attrs?.['panelType'];
      out.push(indent + `[${typeof kind === 'string' ? kind : 'panel'}]`);
      for (const c of n.content ?? []) block(c, depth + 1, out);
      return;
    }
    case 'rule':
      out.push(indent + '---');
      return;
    case 'table': {
      for (const row of n.content ?? []) {
        const cells = (row.content ?? []).map((cell) => {
          const sub: string[] = [];
          for (const c of cell.content ?? []) block(c, 0, sub);
          return trimTrailingBlanks(sub).join(' ').trim();
        });
        out.push(indent + cells.join(' | '));
      }
      return;
    }
    case 'mediaSingle':
    case 'mediaGroup':
    case 'media': {
      const alt = n.attrs?.['alt'];
      out.push(indent + `[attachment${typeof alt === 'string' && alt ? ': ' + alt : ''}]`);
      return;
    }
    case 'expand':
    case 'nestedExpand': {
      const title = n.attrs?.['title'];
      if (typeof title === 'string' && title) out.push(indent + title);
      for (const c of n.content ?? []) block(c, depth + 1, out);
      return;
    }
    default: {
      if (n.content) {
        for (const c of n.content) block(c, depth, out);
      } else if (n.text) {
        out.push(indent + n.text);
      } else {
        out.push(indent + `[unsupported: ${n.type}]`);
      }
    }
  }
}

/** Strip Jira wiki markup from a plain string body (server Jira / v2 API). */
export function flattenWikiMarkup(s: string): string {
  return s
    .replace(/\{code(?::[^}]*)?\}/g, '```')
    .replace(/\{noformat\}/g, '```')
    .replace(/\{quote\}/g, '> ')
    .replace(/\{color:[^}]*\}|\{color\}/g, '')
    .replace(/\{panel(?::[^}]*)?\}/g, '')
    .replace(/\[([^\]|]+)\|([^\]]+)\]/g, '$1 ($2)')
    .replace(/(^|\s)[*_](\S[^*_]*?\S|\S)[*_](?=\s|$|[.,;:!?)])/g, '$1$2')
    .replace(/^h([1-6])\.\s*/gm, (_m, l: string) => '#'.repeat(Number(l)) + ' ')
    .replace(/\r\n/g, '\n');
}

/** Render an ADF document (or a plain string body) as plain text. */
export function adfToText(body: unknown): string {
  if (body == null) return '';
  if (typeof body === 'string') return normalize(flattenWikiMarkup(body));
  if (typeof body !== 'object') return String(body);
  validateAdf(body);
  const out: string[] = [];
  block(body as AdfNode, 0, out);
  return normalize(out.join('\n'));
}

function normalize(s: string): string {
  return s
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface Truncated {
  text: string;
  truncated: boolean;
  fullLength: number;
}

/** Truncate on a word boundary, reporting how much was dropped. */
export function truncate(text: string, limit: number): Truncated {
  const fullLength = text.length;
  if (limit <= 0 || fullLength <= limit) return { text, truncated: false, fullLength };
  let cut = text.slice(0, limit);
  const lastBreak = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf(' '));
  if (lastBreak > limit * 0.6) cut = cut.slice(0, lastBreak);
  return { text: cut.trimEnd(), truncated: true, fullLength };
}
