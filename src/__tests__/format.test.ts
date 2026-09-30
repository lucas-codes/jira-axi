/**
 * Golden-parity check: jira-axi hand-rolls its own TOON-flavoured escaping
 * (see src/format.ts) rather than depending on @toon-format/toon at runtime,
 * because the Out class interleaves kv/table/list/text blocks in a shape the
 * library's generic `encode()` does not produce. This test proves the
 * hand-rolled scalar quoting/escaping still matches the real library's rules
 * for representative Jira-shaped strings, so the two don't silently drift.
 *
 * @toon-format/toon is a devDependency only, used here for verification.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encode } from '@toon-format/toon';
import { csvCell } from '../format.ts';

/** Extract how the real encoder renders a single scalar value. */
function realToonScalar(value: string): string {
  // Encode as the sole element of a one-item array so the library treats it
  // as a tabular cell, the same context csvCell is used in. A one-item
  // primitive array is inlined on the header line itself: `v[1]: <cell>`.
  const rendered = encode({ v: [value] });
  const prefix = 'v[1]: ';
  if (!rendered.startsWith(prefix)) throw new Error(`unexpected encoding: ${rendered}`);
  return rendered.slice(prefix.length);
}

test('csvCell matches @toon-format/toon for representative Jira-shaped strings', () => {
  const cases = [
    'DEMO-1',
    'In Progress',
    'a,b',
    'say "hi"',
    'one\ntwo',
    'a\\b',
    '12:30',
    '-1',
    '-story points',
    'true',
    'false',
    'null',
    '3.14',
    '007',
    'a[b]',
    'a{b}',
    '  leading space',
    'trailing space  ',
    'plain sentence with no surprises',
    'Fix: null pointer, again',
    "Multi-line comment\nwith a \"quote\" and, a comma\tand a tab",
  ];
  for (const value of cases) {
    assert.equal(csvCell(value), realToonScalar(value), `mismatch for ${JSON.stringify(value)}`);
  }
});
