// lib/jsonSchemaLite.js
// Validador minimo de JSON Schema, sin dependencias externas (no se
// asume que ajv u otra libreria ya este instalada). Soporta el subset
// de JSON Schema que realmente usamos: $ref (resuelto contra el mismo
// documento raiz), enum, type (incluyendo union con null), object con
// required/additionalProperties, y array con items.
//
// No es un validador JSON Schema completo -- es intencionalmente
// pequeño y auditable, suficiente para el contrato de Smart Import y
// cualquier futuro contrato de structured output similar.

function resolveRef(schema, root) {
  if (schema && schema.$ref) {
    const path = schema.$ref.replace(/^#\//, "").split("/");
    let node = root;
    for (const p of path) node = node[p];
    return node;
  }
  return schema;
}

function validateAgainstSchema(data, schema, root, pathLabel) {
  const errors = [];
  const resolved = resolveRef(schema, root);

  if (resolved.enum) {
    if (!resolved.enum.includes(data)) errors.push(`${pathLabel}: valor "${data}" no esta en enum [${resolved.enum.join(",")}]`);
    return errors;
  }

  if (resolved.type) {
    const types = Array.isArray(resolved.type) ? resolved.type : [resolved.type];
    const actual = data === null ? "null" : Array.isArray(data) ? "array" : typeof data;
    if (!types.includes(actual)) {
      errors.push(`${pathLabel}: tipo esperado ${types.join("|")}, recibido ${actual}`);
      return errors;
    }
  }

  if (resolved.properties && data && typeof data === "object" && !Array.isArray(data)) {
    for (const req of resolved.required || []) {
      if (!(req in data)) errors.push(`${pathLabel}.${req}: campo requerido ausente`);
    }
    if (resolved.additionalProperties === false) {
      const allowed = new Set(Object.keys(resolved.properties));
      for (const key of Object.keys(data)) {
        if (!allowed.has(key)) errors.push(`${pathLabel}.${key}: propiedad no permitida`);
      }
    }
    for (const [key, subSchema] of Object.entries(resolved.properties)) {
      if (key in data) {
        errors.push(...validateAgainstSchema(data[key], subSchema, root, `${pathLabel}.${key}`));
      }
    }
  }

  if (resolved.type === "array" && Array.isArray(data) && resolved.items) {
    data.forEach((item, i) => {
      errors.push(...validateAgainstSchema(item, resolved.items, root, `${pathLabel}[${i}]`));
    });
  }

  return errors;
}

export function validateJsonSchema(data, schema) {
  const errors = validateAgainstSchema(data, schema, schema, "$");
  return { valid: errors.length === 0, errors };
}
