// lib/canonicalThemeTags.js
// Sprint P3.1B.1 (Materiality Real-World Validation). Corrige el bug de
// idioma encontrado en P3.1B: STRATEGIC_RELEVANCE comparaba texto crudo
// de `positions.tema` (español) contra `facts.headline_raw` (ingles,
// via Finnhub) con substring matching directo -- nunca hacia match real
// porque son idiomas distintos.
//
// Fix minimo y robusto: en vez de comparar texto contra texto, ambos
// lados (tema/sector/strategic_role de la posicion, headline del
// evento) se normalizan PRIMERO a un set de tags canonicos
// independientes de idioma, y la comparacion real es interseccion de
// sets de tags -- nunca traduccion automatica, nunca comparacion de
// substrings entre idiomas.
//
// Deliberadamente NO es una ontologia grande -- solo los tags que
// realmente aparecen en los temas reales de este portafolio
// (`positions.tema`/`sector` reales, verificado via Supabase antes de
// escribir esta lista). Agregar un tag nuevo es agregar una entrada
// aqui, nunca logica nueva.

export const CANONICAL_TAGS = Object.freeze({
  SEMICONDUCTORS: { es: ["semiconductores"], en: ["semiconductor", "semiconductors", "chip", "chips", "chipmaker"] },
  AI_DATACENTER: { es: ["infraestructura ia", "centro de datos"], en: ["data center", "datacenter", "ai infrastructure"] },
  AI_CLOUD: { es: ["cloud", "nube"], en: ["cloud"] },
  AI_SOFTWARE: { es: ["inteligencia artificial"], en: ["artificial intelligence"] },
  HARDWARE_TECH: { es: ["hardware"], en: ["hardware", "iphone", "smartphone"] },
  ENERGY: { es: ["energia"], en: ["energy"] },
  CYBERSECURITY: { es: ["ciberseguridad"], en: ["cybersecurity", "cyber security"] },
  CRYPTO: { es: ["cripto", "mineria bitcoin"], en: ["crypto", "bitcoin", "cryptocurrency"] },
});

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Whole-word/whole-phrase match -- nunca substring ciego (evita que
// "ia" matchee dentro de "Nvidia" o "historia"; los limites \b
// requieren que ambos lados de la frase sean frontera de palabra).
function containsPhrase(lowerText, phrase) {
  const pattern = new RegExp(`\\b${escapeRegex(phrase)}\\b`, "i");
  return pattern.test(lowerText);
}

// Dado un texto libre (en cualquiera de los 2 idiomas cubiertos),
// devuelve el array de tags canonicos que matchean -- nunca traduce,
// solo reconoce.
export function tagsFromText(text) {
  if (!text) return [];
  const lower = String(text).toLowerCase();
  const tags = [];
  for (const [tag, keywords] of Object.entries(CANONICAL_TAGS)) {
    const allKeywords = [...keywords.es, ...keywords.en];
    if (allKeywords.some((kw) => containsPhrase(lower, kw))) {
      tags.push(tag);
    }
  }
  return tags;
}

// Union de tags de varios campos de texto (tema + sector + strategic_role,
// o cualquier combinacion) -- deduplicado.
export function tagsFromFields(...texts) {
  const set = new Set();
  for (const t of texts) {
    for (const tag of tagsFromText(t)) set.add(tag);
  }
  return [...set];
}
