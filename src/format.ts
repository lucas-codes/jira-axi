/**
 * `*-axi` house output format.
 *
 *   key: value              scalar header lines
 *   name[N]{a,b,c}:         table block, N rows, CSV-ish rows indented 2
 *   name[N]:                list block
 *   name:                   text block, body indented 2
 *
 * Values are quoted only when they would otherwise be ambiguous, which keeps
 * the byte count (and therefore the token count) down.
 */

export type Scalar = string | number | boolean | null | undefined;

// Matches the real TOON grammar (@toon-format/toon's `isSafeUnquoted` /
// `escapeString`), not CSV: a bare value must not look like a number,
// boolean, or null literal, must not carry structural characters (the `,`
// delimiter, `:`, `[`, `]`, `{`, `}`), must not start with `-` (list marker),
// and must not have leading/trailing whitespace. Anything else round-trips
// through a real TOON decoder unquoted.
const BOOL_OR_NULL = /^(true|false|null)$/;
const NUMERIC_LIKE = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/;
// A leading zero followed by another digit ("007") is not a valid JSON
// number, but a real TOON decoder still treats it as number-shaped and would
// misparse it, so it must be quoted too.
const LEADING_ZERO_LIKE = /^-?0\d/;
const STRUCTURAL = /[,:[\]{}]/;
const CONTROL_CHARS = /[\x00-\x1f]/;
const CONTROL_CHARS_G = /[\x00-\x1f]/g;

function isSafeUnquoted(value: string): boolean {
  if (value === '') return false;
  if (value !== value.trim()) return false;
  if (BOOL_OR_NULL.test(value) || NUMERIC_LIKE.test(value) || LEADING_ZERO_LIKE.test(value)) return false;
  if (STRUCTURAL.test(value)) return false;
  if (value.includes('"') || value.includes('\\')) return false;
  if (CONTROL_CHARS.test(value)) return false;
  if (value.startsWith('-')) return false;
  return true;
}

/**
 * Escapes a string the way `@toon-format/toon` does: backslash-escape `\`,
 * `"`, `\n`, `\r`, `\t`, and emit other control characters as `\uXXXX`.
 * (Not CSV-style doubled quotes — a real TOON decoder does not understand
 * `""` as an escaped quote, and collapsing newlines to spaces is data loss.)
 */
function escapeToon(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    .replace(CONTROL_CHARS_G, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

/** Quote and escape a scalar exactly the way a TOON table cell must. */
export function csvCell(value: Scalar): string {
  if (value == null) return '-';
  // A real number or boolean is emitted bare, exactly like the real TOON
  // encoder's `encodePrimitive`: quoting is only for STRING values that would
  // otherwise be misread as one of these literals on decode.
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === '') return '-';
  if (isSafeUnquoted(value)) return value;
  return '"' + escapeToon(value) + '"';
}

/** Quote and escape a scalar for a `key: value` header line. */
function kvValue(s: string): string {
  if (isSafeUnquoted(s)) return s;
  return '"' + escapeToon(s) + '"';
}

export class Out {
  private lines: string[] = [];

  kv(key: string, value: Scalar): this {
    if (value == null || value === '') {
      this.lines.push(`${key}: -`);
      return this;
    }
    const s = String(value);
    this.lines.push(`${key}: ${typeof value === 'string' ? kvValue(s) : s}`);
    return this;
  }

  /** Only emit when there is something to say. */
  kvIf(key: string, value: Scalar): this {
    if (value == null || value === '' || (Array.isArray(value) && value.length === 0)) return this;
    return this.kv(key, value);
  }

  table(name: string, columns: string[], rows: Scalar[][], countLabel?: string): this {
    const n = countLabel ?? String(rows.length);
    this.lines.push(`${name}[${n}]{${columns.join(',')}}:`);
    for (const row of rows) {
      this.lines.push('  ' + row.map(csvCell).join(','));
    }
    return this;
  }

  list(name: string, items: string[], countLabel?: string): this {
    if (items.length === 0) return this;
    const n = countLabel ?? String(items.length);
    this.lines.push(`${name}[${n}]:`);
    for (const item of items) this.lines.push('  ' + item);
    return this;
  }

  /** A multi-line text block, indented by two spaces. */
  text(header: string, body: string): this {
    if (!body) return this;
    this.lines.push(`${header}:`);
    for (const line of body.split('\n')) this.lines.push(line ? '  ' + line : '');
    return this;
  }

  raw(line: string): this {
    this.lines.push(line);
    return this;
  }

  blank(): this {
    this.lines.push('');
    return this;
  }

  toString(): string {
    return this.lines.join('\n');
  }
}

export function print(out: Out | string): void {
  process.stdout.write(String(out).replace(/\n*$/, '\n'));
}

/** Never use `echo` for JSON — zsh's builtin expands escapes and corrupts it. */
export function printJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}
