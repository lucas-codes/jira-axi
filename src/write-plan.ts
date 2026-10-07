import { createHash } from 'node:crypto';
import { flagBool, flagStr, type Args } from './args.ts';
import { JiraError } from './jira.ts';
export interface PlannedJsonWrite {
  method: 'POST' | 'PUT';
  path: string;
  query: Record<string, string>;
  body: unknown;
}
/** The plan carries the file's digest, not its bytes, so payloadDigest covers content and filename while previews stay small. */
export interface PlannedUpload {
  method: 'POST';
  path: string;
  query: Record<string, string>;
  upload: { filename: string; size: number; sha256: string; mimeType: string };
}
export type PlannedWrite = PlannedJsonWrite | PlannedUpload;
const granted: unique symbol = Symbol('write grant');
export interface WriteGrant {
  readonly [granted]: PlannedWrite;
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value))
    return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
  return value;
}
export function payloadDigest(plan: PlannedWrite): string {
  return createHash('sha256').update(JSON.stringify(canonical(plan))).digest('hex').slice(0, 12);
}
export function confirmWrite(args: Args, plan: PlannedWrite): WriteGrant | undefined {
  const yes = flagBool(args, 'yes');
  if (args.flags.has('confirm')) {
    const digest = flagStr(args, 'confirm');
    if (!yes || !digest || !/^[a-f0-9]{12}$/.test(digest) || digest !== payloadDigest(plan))
      throw new JiraError('--confirm requires --yes and the matching 12-character payloadDigest', 'usage');
  }
  return yes ? { [granted]: plan } : undefined;
}
export function assertGrant(plan: PlannedWrite, grant: WriteGrant): void {
  if (grant[granted] !== plan)
    throw new JiraError('Write grant does not match plan', 'security');
}
