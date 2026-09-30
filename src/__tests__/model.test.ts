import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseIssue, parseIssueList, parseSprints } from '../model.ts';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): unknown => JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf8'));

const OPTS = { baseUrl: 'https://example.atlassian.net' };

test('parses the raw v3 API shape from `jira issue view --raw`', () => {
  const issue = parseIssue(fixture('issue-view.json'), OPTS);
  assert.equal(issue.key, 'DEMO-101');
  assert.equal(issue.type, 'Task');
  assert.equal(issue.status, 'In Progress');
  assert.equal(issue.statusCategory, 'In Progress');
  assert.equal(issue.priority, 'High');
  assert.equal(issue.assignee, 'Alex Example');
  assert.equal(issue.reporter, 'Sam Sample');
  assert.deepEqual(issue.components, ['Platform Internals']);
  assert.equal(issue.created, '2026-09-14');
  assert.equal(issue.url, 'https://example.atlassian.net/browse/DEMO-101');
  assert.ok(issue.description.length > 200);
  assert.ok(!issue.description.includes('"type"'), 'description must be flattened, not raw ADF');
  assert.equal(issue.commentTotal, 0);
});

test('parses comments with flattened bodies', () => {
  const issue = parseIssue(fixture('issue-view-comments.json'), OPTS);
  assert.equal(issue.commentTotal, 7);
  assert.equal(issue.comments.length, 3);
  const first = issue.comments[0]!;
  assert.equal(first.author, 'Alex Example');
  assert.match(first.created, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(first.body.length > 50);
  assert.ok(!first.body.includes('{"type"'));
});

test('parses the CLI struct shape from `jira issue list --raw`', () => {
  const issues = parseIssueList(fixture('issue-list.json'), OPTS);
  assert.ok(issues.length >= 3);
  const sub = issues.find((i) => i.type === 'Sub-task');
  assert.ok(sub, 'list fixture should contain a sub-task');
  assert.equal(sub!.parent?.key, 'DEMO-105');
  assert.ok(sub!.assignee);
  assert.ok(sub!.status);
  for (const i of issues) {
    assert.match(i.key, /^DEMO-\d+$/);
    assert.ok(i.summary.length > 0);
    assert.notEqual(i.type, '?');
  }
});

test('an empty resolution name does not become a resolution', () => {
  const issues = parseIssueList(fixture('issue-list.json'), OPTS);
  assert.equal(issues[0]!.resolution, undefined);
});

test('finds a sprint custom field by shape, whatever its id', () => {
  const issue = parseIssue(
    {
      key: 'DEMO-1',
      fields: {
        summary: 's',
        customfield_10999: [
          { id: 1, name: 'Sprint 40', state: 'closed', boardId: 42 },
          { id: 2, name: 'Sprint 41', state: 'active', boardId: 42 },
        ],
      },
    },
    OPTS,
  );
  assert.equal(issue.sprint, 'Sprint 41');
  assert.equal(issue.sprintState, 'active');
});

test('resolves the epic link through the configured custom field', () => {
  const issue = parseIssue(
    { key: 'DEMO-2', fields: { summary: 's', customfield_10014: 'DEMO-100' } },
    { ...OPTS, epicLinkField: 'customfield_10014' },
  );
  assert.equal(issue.epic, 'DEMO-100');
});

test('parses issue links in both directions and subtasks', () => {
  const issue = parseIssue({
    key: 'DEMO-3',
    fields: {
      summary: 's',
      issuelinks: [
        { type: { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' }, outwardIssue: { key: 'DEMO-4', fields: { summary: 'later', status: { name: 'To Do' } } } },
        { type: { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' }, inwardIssue: { key: 'DEMO-5', fields: { summary: 'earlier' } } },
      ],
      subtasks: [{ key: 'DEMO-6', fields: { summary: 'bit', status: { name: 'Done' } } }],
    },
  });
  assert.deepEqual(issue.links.map((l) => [l.type, l.key]), [
    ['blocks', 'DEMO-4'],
    ['is blocked by', 'DEMO-5'],
  ]);
  assert.equal(issue.links[0]!.status, 'To Do');
  assert.deepEqual(issue.subtasks.map((s) => s.key), ['DEMO-6']);
});

test('survives missing and unexpected fields', () => {
  const issue = parseIssue({ key: 'DEMO-7' });
  assert.equal(issue.type, '?');
  assert.equal(issue.status, '?');
  assert.deepEqual(issue.labels, []);
  assert.equal(issue.description, '');
  assert.throws(() => parseIssue('nope'), /not a JSON object/);
  assert.deepEqual(parseIssueList(null), []);
});

test('accepts the `{issues:[...]}` envelope as well as a bare array', () => {
  const arr = fixture('issue-list.json') as unknown[];
  assert.equal(parseIssueList({ issues: arr }).length, arr.length);
});

test('parses sprints', () => {
  const sprints = parseSprints([
    { id: 12, name: 'Sprint 41', state: 'active', startDate: '2026-09-01T00:00:00.000Z', endDate: '2026-09-15T00:00:00.000Z' },
  ]);
  assert.deepEqual(sprints, [{ id: '12', name: 'Sprint 41', state: 'active', start: '2026-09-01', end: '2026-09-15' }]);
});
