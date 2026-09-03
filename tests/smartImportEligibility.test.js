import test from "node:test";
import assert from "node:assert/strict";
import { isEligibleForCreate, buildProposedChange } from "../lib/reconciliationEngine.js";
import { normalizeTickerInput } from "../lib/assetResolver.js";

function baseNormalized(overrides = {}) {
  return {
    asset: { match_status: "MATCHED_ASSET", asset_id: 14 },
    account: { account_id: 1 },
    type: "BUY",
    quantity: 1.973098215,
    price: 886.93,
    total: { value: 1750, source_type: "EXTRACTED" },
    fee: { value: null, source_type: "UNAVAILABLE" },
    status: { value: "PENDING" },
    transaction_date: "2026-09-03",
    provider_transaction_id: "FIXTURE_PENDING_888",
    warnings: [],
    overall_import_confidence: "HIGH",
    ...overrides,
  };
}

// ================== normalizeTickerInput ==================
test("normalizeTickerInput: trim + uppercase", () => {
  assert.equal(normalizeTickerInput("  meta  "), "META");
  assert.equal(normalizeTickerInput("gev"), "GEV");
  assert.equal(normalizeTickerInput(""), null);
  assert.equal(normalizeTickerInput(null), null);
});

// ================== isEligibleForCreate ==================
test("isEligibleForCreate: extraccion completa y valida -> true", () => {
  assert.equal(isEligibleForCreate(baseNormalized()), true);
});

test("K - HIGH pero incompleta (quantity null) -> false, HIGH no basta", () => {
  const n = baseNormalized({ quantity: null });
  assert.equal(isEligibleForCreate(n), false);
});

test("isEligibleForCreate: overall AMBIGUOUS -> false sin importar el resto", () => {
  const n = baseNormalized({ overall_import_confidence: "AMBIGUOUS" });
  assert.equal(isEligibleForCreate(n), false);
});

test("isEligibleForCreate: asset UNKNOWN_ASSET -> false", () => {
  const n = baseNormalized({ asset: { match_status: "UNKNOWN_ASSET", asset_id: null } });
  assert.equal(isEligibleForCreate(n), false);
});

test("isEligibleForCreate: status CANCELLED -> false (nunca CREATE en V1)", () => {
  const n = baseNormalized({ status: { value: "CANCELLED" } });
  assert.equal(isEligibleForCreate(n), false);
});

test("isEligibleForCreate: status UNKNOWN -> false", () => {
  const n = baseNormalized({ status: { value: "UNKNOWN" } });
  assert.equal(isEligibleForCreate(n), false);
});

test("isEligibleForCreate: DOCUMENT_TYPE_TRANSACTION_TYPE_CONFLICT -> false", () => {
  const n = baseNormalized({ warnings: ["DOCUMENT_TYPE_TRANSACTION_TYPE_CONFLICT"] });
  assert.equal(isEligibleForCreate(n), false);
});

test("isEligibleForCreate: sin total NI price -> false (sin info economica)", () => {
  const n = baseNormalized({ total: { value: null, source_type: "UNAVAILABLE" }, price: null });
  assert.equal(isEligibleForCreate(n), false);
});

test("isEligibleForCreate: quantity = 0 -> false (debe ser > 0)", () => {
  const n = baseNormalized({ quantity: 0 });
  assert.equal(isEligibleForCreate(n), false);
});

// ================== buildProposedChange: NO_MATCH ==================
test("buildProposedChange: NO_MATCH + eligible -> CREATE", () => {
  const normalized = baseNormalized();
  const duplicateResult = { result: "NO_MATCH", matchedTransactionId: null, matchLevel: null };
  const effects = { holdings: "NONE" };
  const r = buildProposedChange({ normalized, duplicateResult, matchedTransaction: null, effects, eligibility: isEligibleForCreate(normalized) });
  assert.equal(r.operation, "CREATE");
  assert.equal(r.fields.asset_id, 14);
  assert.equal(r.fields.status, "PENDING");
});

test("buildProposedChange: NO_MATCH pero NO eligible -> REVIEW, reason NOT_ELIGIBLE_FOR_CREATE", () => {
  const normalized = baseNormalized({ quantity: null });
  const duplicateResult = { result: "NO_MATCH", matchedTransactionId: null, matchLevel: null };
  const r = buildProposedChange({ normalized, duplicateResult, matchedTransaction: null, effects: {}, eligibility: isEligibleForCreate(normalized) });
  assert.equal(r.operation, "REVIEW");
  assert.equal(r.reason, "NOT_ELIGIBLE_FOR_CREATE");
});

// ================== buildProposedChange: PENDING -> EXECUTED (contra fila REAL) ==================
test("PENDING->EXECUTED - fila REAL de Supabase (id=82, status=PENDING) + nueva evidencia EXECUTED + mismo provider_transaction_id -> UPDATE", () => {
  // Fila real devuelta por Supabase para transactions.id=82 (fixture GEV pendiente)
  const realMatchedTransaction = { id: 82, status: "PENDING", provider_transaction_id: "FIXTURE_PENDING_888", transaction_fingerprint: null };
  const duplicateResult = { result: "EXACT_DUPLICATE", matchedTransactionId: 82, matchLevel: "PROVIDER_ID" };
  const normalized = baseNormalized({ status: { value: "EXECUTED" } }); // nueva evidencia: ya se ejecuto
  const r = buildProposedChange({ normalized, duplicateResult, matchedTransaction: realMatchedTransaction, effects: {}, eligibility: isEligibleForCreate(normalized) });
  assert.equal(r.operation, "UPDATE");
  assert.equal(r.target_id, 82);
  assert.deepEqual(r.fields, { status: "EXECUTED" });
  assert.equal(r.reason, "PENDING_TO_EXECUTED");
});

test("buildProposedChange: EXACT_DUPLICATE pero la transaccion existente YA estaba EXECUTED -> REVIEW, no UPDATE", () => {
  const matchedTransaction = { id: 82, status: "EXECUTED", provider_transaction_id: "FIXTURE_PENDING_888" };
  const duplicateResult = { result: "EXACT_DUPLICATE", matchedTransactionId: 82, matchLevel: "PROVIDER_ID" };
  const normalized = baseNormalized({ status: { value: "EXECUTED" } });
  const r = buildProposedChange({ normalized, duplicateResult, matchedTransaction, effects: {}, eligibility: true });
  assert.equal(r.operation, "REVIEW");
  assert.equal(r.reason, "EXACT_DUPLICATE");
});

// ================== L. POSSIBLE_DUPLICATE nunca dispara UPDATE ==================
test("L - POSSIBLE_DUPLICATE (DATE_ONLY) + status PENDING->EXECUTED: SIEMPRE REVIEW, nunca UPDATE", () => {
  const matchedTransaction = { id: 99, status: "PENDING", provider_transaction_id: null, transaction_fingerprint: null };
  const duplicateResult = { result: "POSSIBLE_DUPLICATE", matchedTransactionId: 99, matchLevel: "DATE_ONLY" };
  const normalized = baseNormalized({ status: { value: "EXECUTED" }, provider_transaction_id: null });
  const r = buildProposedChange({ normalized, duplicateResult, matchedTransaction, effects: {}, eligibility: true });
  assert.equal(r.operation, "REVIEW"); // NUNCA UPDATE aqui, es la aserción central del test
  assert.equal(r.reason, "POSSIBLE_DUPLICATE");
});

test("buildProposedChange: EXACT_DUPLICATE via EXACT_TIMESTAMP (no solo PROVIDER_ID) tambien puede disparar UPDATE", () => {
  const matchedTransaction = { id: 50, status: "PENDING", provider_transaction_id: null };
  const duplicateResult = { result: "EXACT_DUPLICATE", matchedTransactionId: 50, matchLevel: "EXACT_TIMESTAMP" };
  const normalized = baseNormalized({ status: { value: "EXECUTED" }, provider_transaction_id: null });
  const r = buildProposedChange({ normalized, duplicateResult, matchedTransaction, effects: {}, eligibility: true });
  assert.equal(r.operation, "UPDATE");
});
