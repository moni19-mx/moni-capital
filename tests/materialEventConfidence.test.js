import { test } from "node:test";
import assert from "node:assert/strict";
import { computeConfidenceBreakdown } from "../lib/materialEventConfidence.js";
import { CONFIDENCE_POLICY_VERSION, CONFIDENCE_WEIGHTS } from "../lib/materialEventVersioning.js";
import { FRESHNESS_STATUS } from "../lib/materialEventTemporal.js";

// I. confidence breakdown reproducible
test("I - mismo input siempre produce el mismo breakdown (reproducible, determinista)", () => {
  const input = {
    primaryEvidenceTier: 1, knownFactKeys: 3, expectedFactKeys: ["counterparty", "deal_value", "effective_date"],
    freshnessStatus: FRESHNESS_STATUS.FRESH,
    sources: [{ provider: "sec_edgar", attributed_wire: null }, { provider: "fmp", attributed_wire: null }],
  };
  const a = computeConfidenceBreakdown(input);
  const b = computeConfidenceBreakdown(input);
  assert.deepEqual(a, b);
});

test("I - breakdown expone los 4 factores nombrados, nunca solo un numero suelto", () => {
  const r = computeConfidenceBreakdown({
    primaryEvidenceTier: 1, knownFactKeys: 2, expectedFactKeys: ["a", "b"],
    freshnessStatus: FRESHNESS_STATUS.FRESH, sources: [{ provider: "sec_edgar" }],
  });
  assert.ok("source_confidence" in r);
  assert.ok("data_completeness" in r);
  assert.ok("freshness_confidence" in r);
  assert.ok("corroboration_confidence" in r);
  assert.ok("overall_confidence" in r);
});

test("overall_confidence usa exactamente los pesos versionados de materialEventVersioning.js", () => {
  const r = computeConfidenceBreakdown({
    primaryEvidenceTier: 1, knownFactKeys: 4, expectedFactKeys: ["a", "b", "c", "d"],
    freshnessStatus: FRESHNESS_STATUS.FRESH, sources: [{ provider: "sec_edgar" }, { provider: "fmp" }, { provider: "finnhub" }],
  });
  const expected = Math.round(
    100 * CONFIDENCE_WEIGHTS.source + 100 * CONFIDENCE_WEIGHTS.completeness + 100 * CONFIDENCE_WEIGHTS.freshness + 90 * CONFIDENCE_WEIGHTS.corroboration
  );
  assert.equal(r.overall_confidence, expected);
});

// J. confidence_policy_version persistido
test("J - confidence_policy_version viaja en cada breakdown, igual al de materialEventVersioning.js", () => {
  const r = computeConfidenceBreakdown({
    primaryEvidenceTier: 3, knownFactKeys: 1, expectedFactKeys: ["a"], freshnessStatus: FRESHNESS_STATUS.RECENT, sources: [],
  });
  assert.equal(r.confidence_policy_version, CONFIDENCE_POLICY_VERSION);
});

// N. fuente sin URL/timestamp → degraded confidence, no fake data
test("N - cero facts conocidos produce DATA_COMPLETENESS 0, nunca un valor inventado por default", () => {
  const r = computeConfidenceBreakdown({
    primaryEvidenceTier: 4, knownFactKeys: 0, expectedFactKeys: ["counterparty", "deal_value"],
    freshnessStatus: FRESHNESS_STATUS.STALE, sources: [],
  });
  assert.equal(r.data_completeness, 0);
  assert.equal(r.corroboration_confidence, 0);
  assert.equal(r.independent_source_count, 0);
  assert.ok(r.overall_confidence < 30, "confidence debe quedar visiblemente degradada, no un numero medio artificial");
});

test("N - fuente Tier 4 (analyst/community) produce SOURCE_CONFIDENCE baja, nunca igual a Tier 1", () => {
  const tier4 = computeConfidenceBreakdown({ primaryEvidenceTier: 4, knownFactKeys: 1, expectedFactKeys: ["a"], freshnessStatus: FRESHNESS_STATUS.FRESH, sources: [{ provider: "x" }] });
  const tier1 = computeConfidenceBreakdown({ primaryEvidenceTier: 1, knownFactKeys: 1, expectedFactKeys: ["a"], freshnessStatus: FRESHNESS_STATUS.FRESH, sources: [{ provider: "x" }] });
  assert.ok(tier4.source_confidence < tier1.source_confidence);
});

test("corroboration tiene retornos decrecientes: 3 fuentes no vale el triple que 1", () => {
  const one = computeConfidenceBreakdown({ primaryEvidenceTier: 3, knownFactKeys: 1, expectedFactKeys: ["a"], freshnessStatus: FRESHNESS_STATUS.FRESH, sources: [{ provider: "a" }] });
  const three = computeConfidenceBreakdown({ primaryEvidenceTier: 3, knownFactKeys: 1, expectedFactKeys: ["a"], freshnessStatus: FRESHNESS_STATUS.FRESH, sources: [{ provider: "a" }, { provider: "b" }, { provider: "c" }] });
  assert.ok(three.corroboration_confidence > one.corroboration_confidence);
  assert.ok(three.corroboration_confidence < one.corroboration_confidence * 3);
});
