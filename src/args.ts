/** Minimal flag parser: `--flag`, `--flag value`, `--flag=value`, `-x`. */

import { JiraError } from './jira.ts';

export interface Args {
  command?: string;
  positional: string[];
  flags: Map<string, string | true>;
}

export function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) {
        flags.set(a.slice(2, eq), a.slice(eq + 1));
      } else {
        const name = a.slice(2);
        const next = argv[i + 1];
        if (next != null && !next.startsWith('-')) {
          flags.set(name, next);
          i++;
        } else {
          flags.set(name, true);
        }
      }
    } else if (a.startsWith('-') && a.length > 1) {
      const name = a.slice(1);
      const next = argv[i + 1];
      if (next != null && !next.startsWith('-')) {
        flags.set(name, next);
        i++;
      } else {
        flags.set(name, true);
      }
    } else {
      positional.push(a);
    }
  }
  const command = positional.shift();
  return { command, positional, flags };
}

export function flagStr(args: Args, ...names: string[]): string | undefined {
  for (const n of names) {
    const v = args.flags.get(n);
    if (typeof v === 'string') return v;
  }
  return undefined;
}

export function flagBool(args: Args, ...names: string[]): boolean {
  for (const n of names) {
    const v = args.flags.get(n);
    if (v === true) return true;
    if (typeof v === 'string') return v !== 'false' && v !== '0';
  }
  return false;
}

export function flagNum(args: Args, name: string): number | undefined {
  const v = flagStr(args, name);
  if (v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function flagList(args: Args, ...names: string[]): string[] {
  const v = flagStr(args, ...names);
  if (!v) return [];
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Fails loudly on any flag a command does not declare, instead of silently
 * ignoring it. An agent that invents a flag needs to learn that it did
 * nothing rather than assume it worked — an unknown flag is a usage error
 * (exit 2), the same as any other malformed invocation.
 */
export function assertKnownFlags(args: Args, allowed: readonly string[]): void {
  const known = new Set(allowed);
  const unknown = [...args.flags.keys()].filter((k) => !known.has(k));
  if (unknown.length === 0) return;
  const rendered = unknown.map((f) => (f.length === 1 ? `-${f}` : `--${f}`)).join(', ');
  throw new JiraError(
    `unknown flag${unknown.length > 1 ? 's' : ''}: ${rendered}`,
    'usage',
    'Run `jira-axi --help` for the flags this command accepts.',
  );
}
