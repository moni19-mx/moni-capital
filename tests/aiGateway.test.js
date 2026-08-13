// tests/aiGateway.test.js
// Pruebas deterministas del AI Gateway, failover automatico, y helpers de
// concurrencia. CERO llamadas a Anthropic/OpenAI reales -- se inyecta un
// proveedor falso (fake provider) directamente en PROVIDERS, tal como
// pidio la revision critica pre-Sprint-1 (punto 6: "provider fake/mock").
//
// Correr con: node tests/aiGateway.test.js

import { callModel, PROVIDERS } from "../lib/aiGateway.js";
import { mapWithConcurrency } from "../lib/aiPriceCache.js";

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log(`  ok  ${label}`); }
  else { failed++; console.log(`  FAIL  ${label}`); }
}

function fakeUsage(model) {
  return { model, inputTokens: 100, outputTokens: 20, totalTokens: 120 };
}

function fakeTextResponse(model, text = "respuesta de prueba") {
  return async () => ({
    content: text,
    contentBlocks: [{ type: "text", text }],
    toolCalls: [],
    stopReason: "end_turn",
    usage: fakeUsage(model),
  });
}

function fakeToolUseResponse(model, toolName) {
  return async () => ({
    content: null,
    contentBlocks: [{ type: "tool_use", id: "call_1", name: toolName, input: {} }],
    toolCalls: [{ id: "call_1", name: toolName, input: {} }],
    stopReason: "tool_use",
    usage: fakeUsage(model),
  });
}

function fakeRetryableError(message = "timeout") {
  return async () => { const e = new Error(message); e.retryable = true; throw e; };
}

function fakeNonRetryableError(message = "bad_request") {
  return async () => { const e = new Error(message); e.retryable = false; throw e; };
}

async function run() {
  console.log("Moni AI -- tests deterministas del Gateway (sin llamadas reales)\n");

  // 1. Respuesta normal, sin herramientas
  {
    const backup = PROVIDERS.anthropic;
    PROVIDERS.anthropic = fakeTextResponse("fake-model");
    const r = await callModel({ system: "s", messages: [{ role: "user", content: "hola" }], tools: [], authContext: { authenticated: true } });
    assert(r.content === "respuesta de prueba", "callModel: devuelve el texto del proveedor");
    assert(r.usage.provider === "anthropic", "callModel: usage.provider correcto");
    assert(r.usage.fallbackUsed == null || r.usage.fallbackUsed === undefined, "callModel: no marca fallback en camino feliz");
    PROVIDERS.anthropic = backup;
  }

  // 2. authContext no autenticado -> nunca llega al proveedor
  {
    let called = false;
    const backup = PROVIDERS.anthropic;
    PROVIDERS.anthropic = async () => { called = true; return {}; };
    try {
      await callModel({ system: "s", messages: [], tools: [], authContext: { authenticated: false } });
      assert(false, "callModel: debe lanzar si no esta autenticado");
    } catch (e) {
      assert(e.message === "unauthorized", "callModel: rechaza sin autenticacion");
      assert(!called, "callModel: nunca invoca al proveedor si no esta autenticado");
    }
    PROVIDERS.anthropic = backup;
  }

  // 3. Failover automatico: primario falla con error reintentable, sin providerOverride
  {
    const backupA = PROVIDERS.anthropic;
    const backupT = PROVIDERS["gpt-5.6-terra"];
    PROVIDERS.anthropic = fakeRetryableError("HTTP 503");
    PROVIDERS["gpt-5.6-terra"] = fakeTextResponse("terra-fake", "respondio el fallback");
    const r = await callModel({ system: "s", messages: [{ role: "user", content: "hola" }], tools: [], authContext: { authenticated: true } });
    assert(r.content === "respondio el fallback", "failover: usa el fallback cuando el primario falla con error reintentable");
    assert(r.usage.fallbackUsed === true, "failover: marca fallbackUsed=true");
    assert(r.usage.originalProvider === "anthropic", "failover: registra cual era el proveedor original");
    PROVIDERS.anthropic = backupA;
    PROVIDERS["gpt-5.6-terra"] = backupT;
  }

  // 4. NO failover si el error no es reintentable (ej. tool fallo, no el proveedor)
  {
    const backupA = PROVIDERS.anthropic;
    const backupT = PROVIDERS["gpt-5.6-terra"];
    let fallbackCalled = false;
    PROVIDERS.anthropic = fakeNonRetryableError("bad_request");
    PROVIDERS["gpt-5.6-terra"] = async () => { fallbackCalled = true; return fakeTextResponse("terra")(); };
    try {
      await callModel({ system: "s", messages: [], tools: [], authContext: { authenticated: true } });
      assert(false, "no-failover: debe propagar el error no reintentable");
    } catch (e) {
      assert(e.message === "bad_request", "no-failover: propaga el error original sin tocar el fallback");
    }
    assert(!fallbackCalled, "no-failover: nunca llama al fallback si el error no es de transporte");
    PROVIDERS.anthropic = backupA;
    PROVIDERS["gpt-5.6-terra"] = backupT;
  }

  // 5. NO failover si se pidio un proveedor explicito (benchmarks no deben mezclarse)
  {
    const backupSol = PROVIDERS["gpt-5.6-sol"];
    const backupT = PROVIDERS["gpt-5.6-terra"];
    let fallbackCalled = false;
    PROVIDERS["gpt-5.6-sol"] = fakeRetryableError("HTTP 500");
    PROVIDERS["gpt-5.6-terra"] = async () => { fallbackCalled = true; return fakeTextResponse("terra")(); };
    try {
      await callModel({ system: "s", messages: [], tools: [], authContext: { authenticated: true }, providerOverride: "gpt-5.6-sol" });
      assert(false, "override explicito: debe propagar el error, no usar fallback");
    } catch (e) {
      assert(e.message === "HTTP 500", "override explicito: propaga el error del proveedor pedido explicitamente");
    }
    assert(!fallbackCalled, "override explicito: nunca activa failover aunque el error sea reintentable (protege benchmarks)");
    PROVIDERS["gpt-5.6-sol"] = backupSol;
    PROVIDERS["gpt-5.6-terra"] = backupT;
  }

  // 6. mapWithConcurrency: nunca corre mas de `limit` tareas a la vez
  {
    let active = 0, maxActive = 0;
    const items = Array.from({ length: 20 }, (_, i) => i);
    await mapWithConcurrency(items, 5, async (item) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return item * 2;
    });
    assert(maxActive <= 5, `mapWithConcurrency: nunca excede el limite (maximo observado: ${maxActive})`);
  }

  // 7. mapWithConcurrency: una tarea que falla no tumba las demas
  {
    const items = [1, 2, 3, 4, 5];
    const results = await mapWithConcurrency(items, 3, async (item) => {
      if (item === 3) throw new Error("fallo simulado");
      return item * 10;
    });
    assert(results[0] === 10 && results[1] === 20, "mapWithConcurrency: los items que no fallan devuelven su resultado");
    assert(results[2] === undefined, "mapWithConcurrency: el item que falla no tumba el resto");
    assert(results[3] === 40 && results[4] === 50, "mapWithConcurrency: items despues del fallo se procesan igual");
  }

  console.log(`\n${passed} pasaron, ${failed} fallaron`);
  if (failed > 0) process.exit(1);
}

run();
