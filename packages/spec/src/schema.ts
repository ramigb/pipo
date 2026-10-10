// JSON Schema for .pipo files (docs/spec.md §3, §10.1). Draft-07 for editor compatibility.
// Connector `with:` blocks are attached conditionally from the manifests.
import { AGENTS, CHECKS, INPUTS, type Manifest, OUTPUTS, TAPS, TRANSFORMS } from "./manifests";

type JsonSchema = Record<string, unknown>;

const DURATION = { type: "string", pattern: "^\\d+(\\.\\d+)?(ms|s|m|h|d)$", examples: ["500ms", "10s", "5m", "1h"] };
const EXPR = { type: "string", description: "Expression (docs/spec.md §3.2)" };
const ID = { type: "string", pattern: "^[A-Za-z_][A-Za-z0-9_-]*$" };
const FROM = {
  description: "Where packets come from: an input, a node id, a route branch (node.branch) or a list",
  type: ["string", "array"],
  items: { type: "string" },
  minItems: 1,
};
const THEN = { enum: ["dead_letter", "drop", "continue", "pause", "halt", "agent"] };

const ERROR_POLICY = {
  type: "object",
  properties: {
    retry: { type: "integer", minimum: 0 },
    backoff: { enum: ["fixed", "exponential"] },
    delay: DURATION,
    max_delay: DURATION,
    then: THEN,
    message: { type: "string" },
  },
  additionalProperties: false,
};

const INVALID_POLICY = {
  type: "object",
  properties: { respond: { type: "integer", minimum: 400, maximum: 599 }, then: THEN, message: { type: "string" } },
  additionalProperties: false,
};

/** `if key == name then with: <schema>` for every connector in a catalog. */
function withFor(key: string, catalog: Record<string, Manifest>): JsonSchema[] {
  return Object.entries(catalog).map(([name, m]) => ({
    if: { properties: { [key]: { const: name } }, required: [key] },
    then: { properties: { with: m.with } },
  }));
}

export function buildSchema(): JsonSchema {
  const node = {
    type: "object",
    properties: {
      from: FROM,
      label: { type: "string" },
      tap: {
        type: "string",
        description: "Side effect; data passes on unchanged",
        examples: [...Object.keys(TAPS), "fn.<name>"],
      },
      transform: { type: "string", description: "Replace data", examples: [...Object.keys(TRANSFORMS), "fn.<name>"] },
      filter: { ...EXPR, description: "Keep the packet only when this expression is true" },
      route: {
        type: "object",
        description: "Branch name → expression; the last may be `else`",
        additionalProperties: { type: "string" },
        minProperties: 1,
      },
      agent: { type: "string", examples: Object.keys(AGENTS) },
      with: { type: "object" },
      on_error: ERROR_POLICY,
      loop: {
        type: "object",
        properties: { back_to: { type: "string" }, until: EXPR, max: { type: "integer", minimum: 1 }, then: THEN },
        required: ["back_to", "until", "max"],
        additionalProperties: false,
      },
    },
    required: ["from"],
    additionalProperties: false,
    allOf: [...withFor("tap", TAPS), ...withFor("transform", TRANSFORMS), ...withFor("agent", AGENTS)],
  };

  const input = {
    type: "object",
    properties: {
      via: { enum: Object.keys(INPUTS) },
      with: { type: "object" },
      format: { enum: ["json", "text", "csv", "form", "bytes"] },
      schema: { type: "string" },
      validate: { type: "array", items: EXPR },
      on_invalid: INVALID_POLICY,
    },
    required: ["via"],
    additionalProperties: false,
    allOf: withFor("via", INPUTS),
  };

  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    $id: "https://ramigb.com/pipo/schema/pipo-1.json",
    title: "Pipo pipeline",
    type: "object",
    properties: {
      pipo: { const: 1, description: "Spec version" },
      name: { type: "string", pattern: "^[a-z0-9][a-z0-9-]*$" },
      description: { type: "string" },
      fn: { type: "string", description: "Module of user functions, relative to this file" },
      secrets: {
        type: "object",
        description: "Secret references: op://vault/item/field or env:NAME",
        additionalProperties: { type: "string", pattern: "^(op://|env:)" },
      },
      lifetime: {
        type: "object",
        properties: {
          ttl: DURATION,
          max_packets: { type: "integer", minimum: 1 },
          until: EXPR,
          on_end: { enum: ["drain", "stop"] },
          drain_timeout: DURATION,
        },
        additionalProperties: false,
      },
      concurrency: { type: "integer", minimum: 1 },
      buffer: { type: "object", properties: { max: { type: "integer", minimum: 1 } }, additionalProperties: false },
      errors: ERROR_POLICY,
      input,
      inputs: {
        type: "object",
        description: "Several inputs: input name → input (docs/spec.md §3.3.1)",
        propertyNames: ID,
        additionalProperties: input,
        minProperties: 1,
      },
      nodes: { type: "object", propertyNames: ID, additionalProperties: node },
      output: {
        type: "object",
        properties: {
          from: FROM,
          to: { enum: Object.keys(OUTPUTS) },
          batch: {
            type: "object",
            properties: { size: { type: "integer", minimum: 1 }, within: DURATION },
            required: ["size"],
            additionalProperties: false,
          },
          with: { type: "object" },
          validate: { type: "array", items: EXPR },
          on_invalid: INVALID_POLICY,
          on_error: ERROR_POLICY,
        },
        required: ["from", "to"],
        additionalProperties: false,
        allOf: withFor("to", OUTPUTS),
      },
      delivered: {
        type: "object",
        properties: {
          check: { enum: Object.keys(CHECKS) },
          with: { type: "object" },
          within: DURATION,
          on_fail: ERROR_POLICY,
          stall: {
            type: "object",
            properties: { after: DURATION, then: { enum: ["notify", "pause", "agent"] }, message: { type: "string" } },
            required: ["after"],
            additionalProperties: false,
          },
        },
        additionalProperties: false,
        allOf: withFor("check", CHECKS),
      },
      agent: {
        type: "object",
        properties: {
          control: { type: "boolean" },
          actions: { type: "array", items: { enum: ["pause", "resume", "replay", "push", "ack"] } },
          edit: { type: "array", items: { type: "string" } },
          redact: { type: "array", items: { type: "string" } },
          on_stall: { enum: ["notify", "handle"] },
          verify: { type: "string" },
        },
        additionalProperties: false,
      },
      agent_budget: {
        type: "object",
        properties: {
          per_day: { type: "number", minimum: 0 },
          reset_at: { type: "string", pattern: "^([01]\\d|2[0-3]):[0-5]\\d$" },
          per_packet: { type: "integer", minimum: 1 },
          warn_at: { type: "string", pattern: "^\\d{1,3}%$" },
        },
        additionalProperties: false,
      },
      retention: {
        type: "object",
        properties: {
          data: DURATION,
          trail: DURATION,
          rejected: DURATION,
          dlq: { type: "string", pattern: "^(\\d+(\\.\\d+)?(ms|s|m|h|d)|forever)$" },
        },
        additionalProperties: false,
      },
    },
    required: ["pipo", "name", "output"],
    additionalProperties: false,
  };
}
