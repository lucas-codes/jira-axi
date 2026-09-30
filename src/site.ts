import { JiraError } from './jira.ts';
import { missingConfig, type Env } from './security.ts';
export const EPIC_LINK_FIELD = 'customfield_10014';
export const SPRINT_FIELD = 'customfield_10020';
export const KEY_RE = /^[A-Z][A-Z0-9_]{1,9}-[1-9]\d{0,9}$/;
export const PROJECT_RE = /^[A-Z][A-Z0-9_]{1,9}$/;
export const ISSUE_FIELDS = 'summary,issuetype,status,priority,resolution,assignee,reporter,labels,components,fixVersions,parent,subtasks,issuelinks,created,updated,duedate,timeoriginalestimate,timeestimate,description,customfield_10014,customfield_10020';
// A single DNS label: the only host shape Atlassian Cloud sites use, so userinfo, ports, paths and foreign hosts cannot match.
const SITE_RE = /^(?:https:\/\/)?([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)\.atlassian\.net\/?$/i;
export function siteOrigin(env: Env): string {
  const raw = env.ATLASSIAN_SITE;
  if (!raw)
    throw missingConfig();
  const match = SITE_RE.exec(raw);
  if (!match)
    throw new JiraError('ATLASSIAN_SITE must be <name>.atlassian.net or https://<name>.atlassian.net', 'usage');
  return `https://${match[1]!.toLowerCase()}.atlassian.net`;
}
export function configuredProject(env: Env): string | undefined {
  const raw = env.JIRA_PROJECT;
  if (!raw)
    return undefined;
  const value = raw.toUpperCase();
  if (!PROJECT_RE.test(value))
    throw new JiraError('Invalid JIRA_PROJECT', 'usage');
  return value;
}
export function configuredBoard(env: Env): number | undefined {
  const raw = env.JIRA_BOARD;
  if (!raw)
    return undefined;
  if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw)))
    throw new JiraError('JIRA_BOARD must be a positive integer', 'usage');
  return Number(raw);
}
export function requireBoard(env: Env): number {
  const board = configuredBoard(env);
  if (board === undefined)
    throw new JiraError('This command needs a board; set JIRA_BOARD', 'usage');
  return board;
}
