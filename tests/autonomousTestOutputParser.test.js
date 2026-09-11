// tests/autonomousTestOutputParser.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseNodeTestOutput } from "../lib/autonomousTestOutputParser.js";

const REAL_OUTPUT_SAMPLE = `
ok 672 - some test
  ---
  duration_ms: 1.2
  ...
1..673
# tests 673
# suites 0
# pass 673
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 1820.02
`;

test("A - parseNodeTestOutput: extrae tests/pass/fail/cancelled/skipped de una salida real de node --test", () => {
  const result = parseNodeTestOutput(REAL_OUTPUT_SAMPLE);
  assert.deepEqual(result, { tests: 673, pass: 673, fail: 0, cancelled: 0, skipped: 0, parsed_successfully: true });
});

test("B - parseNodeTestOutput: salida con fallas reales, pass y fail distintos de 0", () => {
  const output = "# tests 10\n# pass 8\n# fail 2\n# cancelled 0\n# skipped 0\n";
  const result = parseNodeTestOutput(output);
  assert.equal(result.pass, 8);
  assert.equal(result.fail, 2);
  assert.equal(result.parsed_successfully, true);
});

test("C - parseNodeTestOutput: salida vacia o irreconocible -> todos null, parsed_successfully:false, NUNCA asume 0", () => {
  const result = parseNodeTestOutput("");
  assert.equal(result.tests, null);
  assert.equal(result.pass, null);
  assert.equal(result.fail, null);
  assert.equal(result.parsed_successfully, false);
});

test("D - parseNodeTestOutput: undefined/null como input nunca truena", () => {
  assert.equal(parseNodeTestOutput(undefined).parsed_successfully, false);
  assert.equal(parseNodeTestOutput(null).parsed_successfully, false);
});
