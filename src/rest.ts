import { assertKnownFlags, flagBool, flagStr, type Args } from './args.ts';
import { read, type ApiRuntime } from './api.ts';
import { Out } from './format.ts';
import { JiraError } from './jira.ts';
import { configuredBoard, configuredProject, siteOrigin, EPIC_LINK_FIELD, PROJECT_RE } from './site.ts';
import { cleanModel, secrets, type Env } from './security.ts';
import { DESCRIPTION, VERSION } from './help.ts';
import { restRead } from './commands/rest-read.ts';
import { restWrite } from './commands/rest-write.ts';
export interface Runtime extends ApiRuntime {
  env: Env;
  write(value: string): void;
  stdin: {
    isTTY: boolean;
    read(): string;
  };
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new JiraError('Malformed response', 'bad_response');
  return value as Record<string, unknown>;
}
export function projectKey(args: Args, env: Env): string | undefined {
  const flag = flagStr(args, 'project', 'p');
  if (flag === undefined)
    return configuredProject(env);
  const p = flag.toUpperCase();
  if (!PROJECT_RE.test(p))
    throw new JiraError('Invalid project', 'usage');
  return p;
}
export function project(args: Args, env: Env): string {
  const p = projectKey(args, env);
  if (!p)
    throw new JiraError('This command needs a project; pass --project or set JIRA_PROJECT', 'usage');
  return p;
}
export async function myself(runtime: Runtime): Promise<Record<string, unknown>> {
  const data = object(await read('/rest/api/3/myself', new URLSearchParams(), runtime));
  if (typeof data.accountId !== 'string' || !data.accountId)
    throw new JiraError('Malformed myself response', 'bad_response');
  return data;
}
export async function restCommand(args: Args, runtime: Runtime): Promise<string> {
  const name = args.command ?? 'status';
  if (['comment', 'create', 'edit'].includes(name))
    return restWrite(args, runtime);
  if (['issue', 'view', 'list', 'ls', 'sprint'].includes(name))
    return restRead(args, runtime);
  if (name !== 'status' && name !== 'me')
    throw new JiraError(`unknown command "${name}"`, 'usage');
  assertKnownFlags(args, ['json', ...(name === 'status' ? ['project', 'p'] : [])]);
  const p = projectKey(args, runtime.env);
  let server: string | undefined;
  let account: unknown;
  let login: unknown;
  let board: string | undefined;
  let problem: string | undefined;
  let reachable = false;
  try {
    server = siteOrigin(runtime.env);
    const user = cleanModel(await myself(runtime), secrets(runtime.env));
    account = user.emailAddress ?? user.displayName;
    login = user.emailAddress;
    reachable = true;
    const boardId = configuredBoard(runtime.env);
    if (boardId !== undefined) {
      try {
        const b = object(await read(`/rest/agile/1.0/board/${boardId}`, new URLSearchParams(), runtime));
        if (!Number.isInteger(b.id) || typeof b.name !== 'string')
          throw new JiraError('Malformed board response', 'bad_response');
        board = cleanModel(b.name, secrets(runtime.env));
      }
      catch {
        // Board access is optional; a successful identity GET is sufficient.
      }
    }
  }
  catch (error) {
    if (name === 'me')
      throw error;
    problem = cleanModel(error instanceof JiraError ? error.hint ?? error.message : String(error), secrets(runtime.env));
  }
  const model = { account, server, project: p, board };
  const status = { bin: process.argv[1] ?? 'jira-axi', version: VERSION, reachable, ...model, login, epicLinkField: EPIC_LINK_FIELD, problem };
  const clean = cleanModel(name === 'status' ? status : model, secrets(runtime.env));
  if (flagBool(args, 'json'))
    return JSON.stringify(clean, null, 2);
  const out = new Out();
  if (name === 'status')
    out.kv('bin', status.bin).kv('description', DESCRIPTION);
  else
    out.kv('account', account as string | undefined);
  out.kvIf('server', server).kvIf('project', p).kvIf('board', board);
  if (name === 'status') {
    out.kv('auth', reachable ? `ok (${account})` : 'unavailable');
    if (problem)
      out.list('attention', [problem]);
    out.list('help', ['Run `jira-axi issue <KEY>` for one issue, `jira-axi list --assignee me` for yours', 'Run `jira-axi --help` for every command and flag']);
  }
  return out.toString();
}
