// tests/reviewerOpenAI.test.js
//
// Solo las guardas de precondicion -- NUNCA hace una llamada de red real
// (ambas pruebas truenan antes de llegar a fetch). callReviewerOpenAI
// esta aislado de lib/providers/openai.js a proposito (ver ese archivo).

import { test } from "node:test";
import assert from "node:assert/strict";
import { callReviewerOpenAI } from "../lib/providers/reviewerOpenAI.js";

test("A - callReviewerOpenAI: sin OPENAI_API_KEY en el entorno -> rechaza antes de cualquier fetch", async () => {
  const originalKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    await assert.rejects(
      () => callReviewerOpenAI({ system: "sys", userMessage: "msg", model: "some-model" }),
      /missing_api_key: OPENAI_API_KEY/
    );
  } finally {
    if (originalKey !== undefined) process.env.OPENAI_API_KEY = originalKey;
  }
});

test("B - callReviewerOpenAI: sin model -> rechaza, el modelo NUNCA se hardcodea como default", async () => {
  const originalKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "sk-test-not-a-real-key";
  try {
    await assert.rejects(
      () => callReviewerOpenAI({ system: "sys", userMessage: "msg", model: undefined }),
      /missing_model/
    );
  } finally {
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
  }
});
