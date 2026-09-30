/**
 * Exercises `main()`'s dispatch-level contract: unknown flags fail loud
 * (exit 2) instead of being silently ignored, and every error — including
 * "unknown command" — is structured output on stdout, never stderr, so an
 * agent never has to merge two streams to see what went wrong.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../index.ts';

test('an unknown flag fails loudly instead of being silently ignored', async () => {
  const originalWrite = process.stdout.write.bind(process.stdout);
  let captured = '';
  process.stdout.write = ((chunk: string) => {
    captured += chunk;
    return true;
  }) as typeof process.stdout.write;
  let code: number;
  try {
    code = await main(['me', '--not-a-real-flag']);
  } finally {
    process.stdout.write = originalWrite;
  }
  assert.equal(code, 2);
  // The message contains `:`, a structural TOON character, so it is quoted.
  assert.match(captured, /^error: "unknown flag: --not-a-real-flag"$/m);
  assert.match(captured, /^code: usage$/m);
});

test('an unknown command is a structured stdout error, not stderr', async () => {
  const originalWrite = process.stdout.write.bind(process.stdout);
  let captured = '';
  process.stdout.write = ((chunk: string) => {
    captured += chunk;
    return true;
  }) as typeof process.stdout.write;
  let code: number;
  try {
    code = await main(['definitely-not-a-command']);
  } finally {
    process.stdout.write = originalWrite;
  }
  assert.equal(code, 2);
  // The message embeds double quotes, escaped per the real TOON grammar.
  assert.match(captured, /^error: "unknown command \\"definitely-not-a-command\\""$/m);
  assert.match(captured, /^code: usage$/m);
});
