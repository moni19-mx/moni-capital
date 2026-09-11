import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isNeverCachePath,
  isAppShellPath,
  isImmutableBuildAsset,
  isStaticShellAsset,
  resolveCacheStrategy,
} from "../lib/pwaCacheStrategy.js";

// N. market-data no queda servido desde cache financiero stale.
test("N - /api/market-data es network-only, nunca cache", () => {
  assert.equal(isNeverCachePath("/api/market-data"), true);
  assert.equal(resolveCacheStrategy("/api/market-data"), "network-only");
});

// O. futures-equity no queda servido desde cache financiero stale.
test("O - /api/futures-equity es network-only, nunca cache", () => {
  assert.equal(isNeverCachePath("/api/futures-equity"), true);
  assert.equal(resolveCacheStrategy("/api/futures-equity"), "network-only");
});

// P. Smart Import no queda cacheado de forma peligrosa.
test("P - /api/smart-import es network-only, nunca cache", () => {
  assert.equal(isNeverCachePath("/api/smart-import"), true);
  assert.equal(resolveCacheStrategy("/api/smart-import"), "network-only");
});

test("todos los endpoints financieros conocidos son network-only", () => {
  const financial = [
    "/api/market-data",
    "/api/futures-equity",
    "/api/market-pulse",
    "/api/search",
    "/api/manage",
    "/api/ai",
    "/api/smart-import",
    "/api/snapshot",
    "/rest/v1/positions",
    "/rest/v1/smart_imports?id=eq.5",
    "/rest/v1/transactions",
    "/auth/v1/token",
  ];
  for (const path of financial) {
    assert.equal(resolveCacheStrategy(path.split("?")[0]), "network-only", `${path} debe ser network-only`);
  }
});

test("app shell (index.html) es network-first, nunca cache-first", () => {
  assert.equal(isAppShellPath("/"), true);
  assert.equal(isAppShellPath("/index.html"), true);
  assert.equal(resolveCacheStrategy("/"), "network-first");
  assert.equal(resolveCacheStrategy("/index.html"), "network-first");
});

test("bundles hasheados bajo /assets/ son cache-first", () => {
  assert.equal(isImmutableBuildAsset("/assets/index-B-qR4zmO.js"), true);
  assert.equal(resolveCacheStrategy("/assets/index-B-qR4zmO.js"), "cache-first");
  assert.equal(resolveCacheStrategy("/assets/index-DlAzfNsn.css"), "cache-first");
});

test("iconos/manifest son stale-while-revalidate", () => {
  assert.equal(isStaticShellAsset("/icons/icon-512.png"), true);
  assert.equal(isStaticShellAsset("/manifest.webmanifest"), true);
  assert.equal(isStaticShellAsset("/favicon.ico"), true);
  assert.equal(resolveCacheStrategy("/icons/icon-512.png"), "stale-while-revalidate");
  assert.equal(resolveCacheStrategy("/manifest.webmanifest"), "stale-while-revalidate");
});

test("ruta desconocida/no reconocida por default nunca se cachea", () => {
  assert.equal(resolveCacheStrategy("/algo-nuevo-que-no-existe-todavia"), "network-only");
  assert.equal(resolveCacheStrategy("/benchmark.html"), "network-only");
});

test("prefijo /api/ cubre subrutas arbitrarias, no solo endpoints conocidos hoy", () => {
  assert.equal(isNeverCachePath("/api/cualquier-endpoint-futuro"), true);
});
