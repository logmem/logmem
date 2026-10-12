// params.mjs — one parameter declaration, two outputs: a zod shape for the
// MCP SDK and a JSON Schema for the hand-rolled tools/list (HTTP JSON path,
// Smithery scoring). Keeps the two from drifting.

import { z } from "zod";

const T = {
  string: () => ({ zod: z.string(), json: { type: "string" } }),
  number: () => ({ zod: z.number(), json: { type: "number" } }),
  boolean: () => ({ zod: z.boolean(), json: { type: "boolean" } }),
  object: () => ({ zod: z.record(z.any()), json: { type: "object", additionalProperties: true } }),
  strings: () => ({ zod: z.array(z.string()), json: { type: "array", items: { type: "string" } } }),
};

/**
 * spec: { name: { type, desc, optional?, enum? } }
 * returns { shape, jsonSchema }
 */
export function params(spec = {}) {
  const shape = {};
  const properties = {};
  const required = [];
  for (const [name, p] of Object.entries(spec)) {
    let { zod, json } = p.enum
      ? { zod: z.enum(p.enum), json: { type: "string", enum: p.enum } }
      : T[p.type]();
    zod = zod.describe(p.desc);
    if (p.optional) zod = zod.optional();
    else required.push(name);
    shape[name] = zod;
    properties[name] = { ...json, description: p.desc };
  }
  const jsonSchema = { type: "object", properties, additionalProperties: false };
  if (required.length) jsonSchema.required = required;
  return { shape, jsonSchema };
}

export const RESULT_SCHEMA = {
  type: "object",
  properties: { ok: { type: "boolean" } },
  additionalProperties: true,
};
