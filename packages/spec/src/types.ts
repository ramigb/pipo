// Shapes of a parsed .pipo file (docs/spec.md §3). These mirror the JSON Schema in
// schema.ts; the schema is the source of truth for validation, these types are for code.

export type Then = "dead_letter" | "drop" | "continue" | "pause" | "halt" | "agent";

export interface ErrorPolicy {
  retry?: number;
  backoff?: "fixed" | "exponential";
  delay?: string;
  max_delay?: string;
  then?: Then;
  message?: string;
}

export interface InvalidPolicy {
  respond?: number;
  then?: Then;
  message?: string;
}

export interface Input {
  via: string;
  with?: Record<string, unknown>;
  format?: "json" | "text" | "csv" | "form" | "bytes";
  schema?: string;
  validate?: string[];
  on_invalid?: InvalidPolicy;
}

export interface Loop {
  back_to: string;
  until: string;
  max: number;
  then?: Then;
}

export const NODE_KINDS = ["tap", "transform", "filter", "route", "agent"] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

export interface Node {
  from: string | string[];
  label?: string;
  tap?: string;
  transform?: string;
  filter?: string;
  route?: Record<string, string>;
  agent?: string;
  with?: Record<string, unknown>;
  on_error?: ErrorPolicy;
  loop?: Loop;
}

export interface Output {
  from: string | string[];
  to: string;
  batch?: { size: number; within?: string };
  with?: Record<string, unknown>;
  validate?: string[];
  on_invalid?: InvalidPolicy;
  on_error?: ErrorPolicy;
}

export interface Delivered {
  check?: string;
  with?: Record<string, unknown>;
  within?: string;
  on_fail?: ErrorPolicy;
  stall?: { after: string; then?: "notify" | "pause" | "agent"; message?: string };
}

export interface Lifetime {
  ttl?: string;
  max_packets?: number;
  until?: string;
  on_end?: "drain" | "stop";
  drain_timeout?: string;
}

export interface AgentPolicy {
  control?: boolean;
  actions?: string[];
  edit?: string[];
  redact?: string[];
  on_stall?: "notify" | "handle";
  verify?: string;
}

export interface Pipeline {
  pipo: 1;
  name: string;
  description?: string;
  fn?: string;
  secrets?: Record<string, string>;
  lifetime?: Lifetime;
  concurrency?: number;
  buffer?: { max?: number };
  errors?: ErrorPolicy;
  input: Input;
  nodes?: Record<string, Node>;
  output: Output;
  delivered?: Delivered;
  agent?: AgentPolicy;
  agent_budget?: { per_day?: number; reset_at?: string; per_packet?: number; warn_at?: string };
  retention?: { data?: string; trail?: string; rejected?: string; dlq?: string };
}

/** The kind key a node declares, or undefined if it declares none. */
export function nodeKind(node: Node): NodeKind | undefined {
  return NODE_KINDS.find((k) => node[k] !== undefined);
}

export function asList<T>(v: T | T[] | undefined): T[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}
