// What this runner implements so far. `pipo check` validates the whole spec; the runner
// refuses to start a pipeline that uses something it can't do yet, rather than silently
// misbehaving. Removing entries here (with tests) is how the runtime grows.

import { FN_REF, type Pipeline } from "@pipo/spec";
import { inputs, outputs, taps, transforms } from "./connectors";

export interface Gap {
  path: string;
  feature: string;
  /** "refuse" blocks start; "warn" starts anyway because data still flows correctly. */
  level: "refuse" | "warn";
}

const IMPLEMENTED = {
  inputs: Object.keys(inputs),
  httpFormats: ["json", "text", "form", "csv", "bytes"],
  taps: ["log", ...Object.keys(taps)],
  transforms: ["map", ...Object.keys(transforms)],
  outputs: Object.keys(outputs),
  checks: [
    "ack",
    "none",
    "record_exists",
    "row_count",
    "query",
    "file_exists",
    "file_nonempty",
    "line_contains",
    "checksum",
    "status",
    "follow_up",
    "external",
  ],
  then: ["dead_letter", "drop", "continue", "pause", "halt", "agent"],
};

export function gaps(p: Pipeline): Gap[] {
  const out: Gap[] = [];
  const refuse = (path: string, feature: string) => out.push({ path, feature, level: "refuse" });

  if (!IMPLEMENTED.inputs.includes(p.input.via)) refuse("input.via", `input '${p.input.via}' (spec §3.3)`);
  if (p.input.via === "http") {
    if (!IMPLEMENTED.httpFormats.includes(p.input.format ?? "json"))
      refuse("input.format", `http format '${p.input.format}'`);
  }

  for (const [id, n] of Object.entries(p.nodes ?? {})) {
    const at = `nodes.${id}`;
    if (n.tap !== undefined && !FN_REF.test(n.tap) && !IMPLEMENTED.taps.includes(n.tap))
      refuse(`${at}.tap`, `tap '${n.tap}'`);
    if (n.transform !== undefined && !FN_REF.test(n.transform) && !IMPLEMENTED.transforms.includes(n.transform)) {
      refuse(`${at}.transform`, `transform '${n.transform}'`);
    }
  }

  if (!IMPLEMENTED.outputs.includes(p.output.to)) refuse("output.to", `output '${p.output.to}' (spec §3.5)`);
  const check = p.delivered?.check ?? "ack";
  if (!IMPLEMENTED.checks.includes(check)) refuse("delivered.check", `delivery check '${check}' (spec §3.10)`);

  const policies = [
    p.errors,
    p.output.on_error,
    p.output.on_invalid,
    p.delivered?.on_fail,
    ...Object.values(p.nodes ?? {}).flatMap((n) => [n.on_error, n.loop]),
  ];
  for (const pol of policies)
    if (pol?.then && !IMPLEMENTED.then.includes(pol.then)) refuse("then", `then: ${pol.then} (spec §3.9)`);
  return out;
}
