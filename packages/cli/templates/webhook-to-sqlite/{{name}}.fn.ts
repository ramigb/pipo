// User functions for {{name}}.pipo, available as fn.<export> (docs/spec.md §3.6).
export function tidy(data: Record<string, unknown>) {
  return { ...data, tidied: true };
}
