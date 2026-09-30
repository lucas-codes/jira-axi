import { safeLink, type AdfNode } from './adf.ts';
export interface AdfDocument extends AdfNode {
  type: 'doc';
  version: 1;
  content: AdfNode[];
}
export function markdownToAdf(source: string): {
  doc: AdfDocument;
  unsupported: string[];
} {
  const unsupported: string[] = [];
  const report = (kind: string) => {
    if (!unsupported.includes(kind))
      unsupported.push(kind);
  };
  const text = (value: string, mark?: string, attrs?: Record<string, unknown>): AdfNode => ({ type: 'text', text: value, ...(mark ? { marks: [{ type: mark, ...(attrs ? { attrs } : {}) }] } : {}) });
  function inline(value: string): AdfNode[] {
    const nodes: AdfNode[] = [];
    let plain = '';
    const flush = () => {
      if (plain) {
        nodes.push(text(plain));
        plain = '';
      }
    };
    for (let i = 0; i < value.length;) {
      const rest = value.slice(i);
      let match: RegExpExecArray | null;
      if ((match = /^\\([!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~])/.exec(rest))) {
        plain += match[1];
        i += match[0].length;
        continue;
      }
      if ((match = /^`([^`]+)`/.exec(rest))) {
        flush();
        nodes.push(text(match[1]!, 'code'));
        i += match[0].length;
        continue;
      }
      if (rest.startsWith('![')) {
        report('image');
        match = /^!\[[^\]]*\]\([^)]*\)/.exec(rest);
        if (match) {
          plain += match[0];
          i += match[0].length;
          continue;
        }
      }
      if (/^<[A-Za-z/]/.test(rest))
        report('html');
      if ((match = /^\[([^\]]+)\]\(([^)]+)\)/.exec(rest))) {
        if (safeLink(match[2])) {
          flush();
          nodes.push(text(match[1]!, 'link', { href: match[2] }));
        }
        else {
          report('link');
          plain += match[0];
        }
        i += match[0].length;
        continue;
      }
      if ((match = /^https?:\/\/[^\s<>]+/.exec(rest))) {
        let href = match[0];
        // Sentence punctuation is not part of an autolink; balanced URL parentheses are.
        while (/[.,;!?]$/.test(href) || (href.endsWith(')') && (href.match(/\)/g)?.length ?? 0) > (href.match(/\(/g)?.length ?? 0))) {
          href = href.slice(0, -1);
        }
        if (safeLink(href)) {
          flush();
          nodes.push(text(href, 'link', { href }));
        }
        else
          plain += href;
        i += href.length;
        continue;
      }
      const marks: [
        RegExp,
        string
      ][] = [[/^\*\*((?:\\.|[^*])+)\*\*/, 'strong'], [/^~~((?:\\.|[^~])+)~~/, 'strike'], [/^\*((?:\\.|[^*])+)\*/, 'em'], [/^_((?:\\.|[^_]|(?<=[\p{L}\p{N}_])_(?=[\p{L}\p{N}_]))+)_(?![\p{L}\p{N}_])/u, 'em']];
      let consumed = false;
      for (const [pattern, mark] of marks) {
        if (rest.startsWith('_') && i > 0 && /[\p{L}\p{N}_]/u.test(value[i - 1]!))
          continue;
        if ((match = pattern.exec(rest))) {
          flush();
          const contents = match[1]!;
          for (let j = 0; j < contents.length; j++) {
            if (contents[j] === '\\') { j++; continue; }
            const code = /^`[^`]+`/.exec(contents.slice(j));
            if (code) { j += code[0].length - 1; continue; }
            if (/^<[A-Za-z/]/.test(contents.slice(j))) report('html');
            if (contents.slice(j).startsWith('![')) report('image');
          }
          nodes.push(text(contents.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~])/g, '$1'), mark));
          i += match[0].length;
          consumed = true;
          break;
        }
      }
      if (consumed)
        continue;
      plain += value[i++];
    }
    flush();
    return nodes;
  }
  const lines = source.replace(/\r\n/g, '\n').replace(/\t/g, '    ').split('\n');
  const listMatch = (line: string) => /^( *)([-*]|\d+\.) +(.*)$/.exec(line);
  function blocks(input: string[]): AdfNode[] {
    const result: AdfNode[] = [];
    let i = 0;
    while (i < input.length) {
      const line = input[i]!;
      if (!line.trim()) {
        i++;
        continue;
      }
      const fence = /^ *```(.*)$/.exec(line);
      if (fence) {
        const code: string[] = [];
        i++;
        while (i < input.length && !/^ *```\s*$/.test(input[i]!))
          code.push(input[i++]!);
        if (i < input.length)
          i++;
        result.push({ type: 'codeBlock', ...(fence[1]?.trim() ? { attrs: { language: fence[1].trim() } } : {}), content: code.join('\n') ? [text(code.join('\n'))] : [] });
        continue;
      }
      const heading = /^ *(#{1,6}) +(.*)$/.exec(line);
      if (heading) {
        result.push({ type: 'heading', attrs: { level: heading[1]!.length }, content: inline(heading[2]!) });
        i++;
        continue;
      }
      if (/^ *---\s*$/.test(line)) {
        result.push({ type: 'rule' });
        i++;
        continue;
      }
      if (/^ *>/.test(line)) {
        const quoted: string[] = [];
        while (i < input.length && /^ *>/.test(input[i]!))
          quoted.push(input[i++]!.replace(/^ *> ?/, ''));
        result.push({ type: 'blockquote', content: blocks(quoted) });
        continue;
      }
      const first = listMatch(line);
      if (first) {
        const indent = first[1]!.length;
        const ordered = /\d/.test(first[2]!);
        const items: AdfNode[] = [];
        while (i < input.length) {
          const item = listMatch(input[i]!);
          if (!item || item[1]!.length !== indent || /\d/.test(item[2]!) !== ordered)
            break;
          const contents: AdfNode[] = [{ type: 'paragraph', content: inline(item[3]!) }];
          const contentIndent = indent + item[2]!.length + 1;
          const nested: string[] = [];
          i++;
          while (i < input.length) {
            const next = input[i]!;
            const spaces = /^ */.exec(next)![0].length;
            if (next.trim() && spaces < contentIndent + 2)
              break;
            if (!next.trim()) {
              if (i + 1 >= input.length || (/^ */.exec(input[i + 1]!)![0].length < contentIndent + 2))
                break;
            }
            nested.push(next.slice(contentIndent + 2));
            i++;
          }
          if (nested.length)
            contents.push(...blocks(nested));
          items.push({ type: 'listItem', content: contents });
        }
        result.push({ type: ordered ? 'orderedList' : 'bulletList', ...(ordered ? { attrs: { order: parseInt(first[2]!, 10) } } : {}), content: items });
        continue;
      }
      const paragraph: string[] = [];
      do {
        if (input[i]!.includes('|') && i + 1 < input.length && /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(input[i + 1]!) && input[i + 1]!.includes('|'))
          report('table');
        paragraph.push(input[i++]!);
      } while (i < input.length && input[i]!.trim() && !/^ *(?:```|#{1,6} |>|---\s*$)/.test(input[i]!) && !listMatch(input[i]!));
      const content: AdfNode[] = [];
      paragraph.forEach((p, n) => {
        if (n)
          content.push({ type: 'hardBreak' });
        content.push(...inline(p));
      });
      result.push({ type: 'paragraph', content });
    }
    return result;
  }
  return { doc: { type: 'doc', version: 1, content: blocks(lines) }, unsupported };
}
