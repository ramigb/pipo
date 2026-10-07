// User functions for people-intake.pipo, available as fn.<export> (docs/spec.md §3.6).
interface Person {
  name: string;
  age: number;
  bio?: string;
}

export function textTransformer(data: Person) {
  return { ...data, name: data.name.trim(), bio: (data.bio ?? "").slice(0, 500) };
}
