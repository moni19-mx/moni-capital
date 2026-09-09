import { test } from "node:test";
import assert from "node:assert/strict";
import { tagsFromText, tagsFromFields, CANONICAL_TAGS } from "../lib/canonicalThemeTags.js";
import { computeStrategicRelevance } from "../lib/materialityEngine.js";

// A. canonical strategic tags español/inglés -- el bug real: tema en
// español, headline en ingles, NUNCA hacia match con substring crudo.
test("A - 'Semiconductores' (tema, español) y 'semiconductor' (headline, ingles) resuelven al MISMO tag canonico", () => {
  const positionTags = tagsFromText("Semiconductores IA");
  const eventTags = tagsFromText("Qualcomm and other semiconductor stocks trade up today");
  assert.ok(positionTags.includes("SEMICONDUCTORS"));
  assert.ok(eventTags.includes("SEMICONDUCTORS"));
});

test("A - computeStrategicRelevance: tema en español + headline en ingles SI suma el overlap ahora (bug corregido)", () => {
  const r = computeStrategicRelevance(
    { headline_raw: "Qualcomm and other semiconductor names rally on chip demand" },
    { isActivePosition: true, tema: "Semiconductores IA", sector: "Semiconductores" }
  );
  assert.ok(r.evidence.some((e) => e.startsWith("canonical_tag_overlap")));
  assert.equal(r.value, 60); // active_position(20) + classified_as(20) + canonical_tag_overlap(20)
});

test("A - 'Energia' (español) y 'energy' (ingles) resuelven al mismo tag", () => {
  assert.deepEqual(tagsFromText("Energia"), ["ENERGY"]);
  assert.deepEqual(tagsFromText("The energy sector rallied today"), ["ENERGY"]);
});

test("A - 'Ciberseguridad' (español) y 'cybersecurity' (ingles) resuelven al mismo tag", () => {
  assert.deepEqual(tagsFromText("Ciberseguridad"), ["CYBERSECURITY"]);
  assert.deepEqual(tagsFromText("New cybersecurity threat disclosed"), ["CYBERSECURITY"]);
});

test("tagsFromText nunca hace match parcial dentro de otra palabra (word boundary real)", () => {
  // "ia" no debe matchear dentro de "Nvidia" ni "historia" -- ningun tag
  // de este mapa usa "ia" sola como keyword, pero probamos el mecanismo
  // de boundary con un caso real del mapa: "energy" no debe matchear "energyx".
  assert.deepEqual(tagsFromText("Nvidia reports strong demand"), []);
  assert.deepEqual(tagsFromText("energyxcompany reports"), []);
});

test("tagsFromFields: union deduplicada de multiples campos de texto", () => {
  const tags = tagsFromFields("Semiconductores IA", "Semiconductores", null);
  assert.deepEqual(tags, ["SEMICONDUCTORS"]);
});

test("texto sin ningun tag reconocido -> array vacio, nunca inventa un tag", () => {
  assert.deepEqual(tagsFromText("un texto totalmente ajeno sin relacion tematica"), []);
  assert.deepEqual(tagsFromText(null), []);
  assert.deepEqual(tagsFromText(undefined), []);
});

test("CANONICAL_TAGS: cada tag tiene al menos 1 keyword en español y 1 en ingles", () => {
  for (const [tag, kw] of Object.entries(CANONICAL_TAGS)) {
    assert.ok(kw.es.length >= 1, `${tag} deberia tener al menos 1 keyword en español`);
    assert.ok(kw.en.length >= 1, `${tag} deberia tener al menos 1 keyword en ingles`);
  }
});
