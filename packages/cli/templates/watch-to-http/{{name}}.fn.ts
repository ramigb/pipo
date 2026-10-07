// User functions for {{name}}.pipo, available as fn.<export> (docs/spec.md §3.6).
export function shape(data: { name: string; content: string }) {
  return { file: data.name, text: data.content.trim() };
}
