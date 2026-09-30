import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseIssue, parseIssueList, parseSprints } from '../model.ts';
import { renderIssue, renderIssueList, renderSprints } from '../render.ts';

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`fixtures/${name}.json`, import.meta.url), 'utf8'));
const opts = { baseUrl: 'https://example.atlassian.net' };
export function goldenOutputs(): Record<string, string> {
  const issue = parseIssue(fixture('issue-view'), opts);
  const comments = parseIssue(fixture('issue-view-comments'), opts);
  const issues = parseIssueList(fixture('issue-list'), opts);
  const sprints = parseSprints(fixture('rest-sprints').values);
  return {
    issue: renderIssue(issue, { full: false, comments: false }),
    'issue-full': renderIssue(issue, { full: true, comments: true }),
    'issue-comments': renderIssue(comments, { full: false, comments: true }),
    'issue-json': JSON.stringify(issue, null, 2),
    list: renderIssueList(issues, { full: false, query: 'assignee=me' }),
    'list-full': renderIssueList(issues, { full: true, query: 'assignee=me' }),
    'list-json': JSON.stringify({ query: 'assignee=me', count: issues.length, issues }, null, 2),
    empty: renderIssueList([], { full: false, query: 'project=DEMO' }),
    sprint: renderSprints(sprints),
    'sprint-json': JSON.stringify({ count: sprints.length, sprints }, null, 2),
  };
}
test('Phase 0 renderer characterization goldens', () => {
  for (const [name, actual] of Object.entries(goldenOutputs())) {
    assert.equal(actual + '\n', readFileSync(new URL(`goldens/${name}.txt`, import.meta.url), 'utf8'), name);
  }
});
