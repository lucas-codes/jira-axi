import { main } from '../index.ts';
export const env = { ATLASSIAN_EMAIL: 'reader@example.com', ATLASSIAN_API_TOKEN: 'DUMMY_SECRET', ATLASSIAN_SITE: 'example.atlassian.net', JIRA_PROJECT: 'DEMO', JIRA_BOARD: '42' };
export async function run(args: string[], responses: unknown[] = [{ accountId: 'abc', emailAddress: 'reader@example.com' }, { id:42, name: 'DEMO' }], status = 200, headers: Record<string,string> = {}) {
  const calls: { url: string; init?: RequestInit }[] = []; let output = ''; let writes = 0;
  const exit = await main(args, { env, fetch: async (url, init) => { calls.push({url: String(url), init}); return new Response(JSON.stringify(responses.shift()), {status,headers:{'content-type':'application/json',...headers}}); }, write:s=>{output+=s;writes++;},stdin:{isTTY:true,read:()=>''} });
  return {exit,output,calls,writes,value:args.includes('--json') ? JSON.parse(output) : undefined};
}
