#!/usr/bin/env node
import { parseArgs, flagBool } from './args.ts';
import { Out } from './format.ts';
import { VERSION, helpText } from './help.ts';
import { JiraError } from './jira.ts';
import { readFileSync } from 'node:fs';
import { restCommand, type Runtime } from './rest.ts';
import { assertNoSecrets, cleanModel, secrets } from './security.ts';

const defaultRuntime: Runtime = {
  env: process.env, fetch: globalThis.fetch, write: s => { process.stdout.write(s); },
  stdin: { isTTY: !!process.stdin.isTTY, read: () => readFileSync(0,'utf8') },
};
export async function main(argv: string[], runtime: Runtime = defaultRuntime): Promise<number> {
  const args = parseArgs(argv);
  const hidden = secrets(runtime.env);
  let output = ''; let exitCode = 0; let bytes: Uint8Array | undefined;
  try {
    if (flagBool(args,'help','h') || args.command === 'help') output = helpText();
    else if (flagBool(args,'version','v','V')) output = `jira-axi ${VERSION}`;
    else {
      const name = args.command ?? 'status';
      if (/^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(name)) { args.positional.unshift(name); args.command = 'issue'; }
      const result = await restCommand(args,runtime);
      if (typeof result === 'string') output = result; else bytes = result;
    }
    assertNoSecrets(output,hidden);
    if (Buffer.byteLength(output) > 512*1024) throw new JiraError('Output exceeds 512 KiB; lower --limit','output_too_large');
  } catch (err) {
    const error = err instanceof JiraError ? err : new JiraError(err instanceof Error ? err.message : String(err),'UNKNOWN');
    exitCode = error.code === 'usage' ? 2 : 1;
    if (['comment','create','edit','transition','attach'].includes(args.command ?? '') && error.details.applied === undefined) error.details.applied = false;
    const value = cleanModel({error:error.message,code:error.code,...error.details,...(error.hint ? {help:[error.hint]} : {})},hidden);
    if (flagBool(args,'json')) output = JSON.stringify(value,null,2);
    else {
      const out = new Out().kv('error',value.error).kv('code',value.code);
      if (value.applied !== undefined) out.kv('applied',value.applied);
      if (value.fields) out.table('fields',['field','message'],value.fields.map(f=>[f.field,f.message]));
      if (value.errorMessages) out.list('errorMessages',value.errorMessages);
      if (value.retryAfter !== undefined) out.kv('retryAfter',value.retryAfter);
      if (value.limitReason) out.kv('limitReason',value.limitReason);
      if (value.help) out.list('help',value.help);
      output = out.toString();
    }
  }
  // A download already passed its own text and secret checks; a trailing newline would break byte-exactness.
  if (bytes) { runtime.write(bytes); return exitCode; }
  try {
    assertNoSecrets(output,hidden);
    if (Buffer.byteLength(output) > 512*1024) throw new JiraError('Output exceeds 512 KiB','output_too_large');
  } catch (error) {
    const code = error instanceof JiraError ? error.code : 'security';
    const fallback = flagBool(args,'json') ? JSON.stringify({error:'Output refused',code}) : `error: Output refused\ncode: ${code}`;
    output = hidden.some(s=>fallback.includes(s)) ? '\n' : fallback;
    if (exitCode === 0) exitCode = 1;
  }
  if (output) runtime.write(output.replace(/\n*$/, '\n'));
  return exitCode;
}
