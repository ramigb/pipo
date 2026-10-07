// Secret references (docs/spec.md §3.7): resolved once at start, never written anywhere,
// and redacted from every log line, journal error and event the runner produces.

export type Resolver = (ref: string) => Promise<string>;

export const defaultResolver: Resolver = async (ref) => {
  if (ref.startsWith("env:")) {
    const name = ref.slice(4);
    const value = process.env[name];
    if (value === undefined) throw new Error(`environment variable ${name} is not set`);
    return value;
  }
  if (ref.startsWith("op://")) {
    if (!Bun.which("op")) throw new Error("1Password CLI 'op' is not installed; install it or use env: references");
    const proc = Bun.spawn(["op", "read", "--no-newline", ref], { stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) throw new Error(`op read failed for ${ref}: ${err.trim()}`);
    return out;
  }
  throw new Error(`unsupported secret reference '${ref}' (use op://… or env:…)`);
};

export class Secrets {
  private constructor(
    readonly values: Record<string, string>,
    private readonly sorted: string[],
  ) {}

  /** `hidden` values (e.g. an agent provider's API key) are redacted too, but not exposed as `secrets.*`. */
  static async resolve(
    refs: Record<string, string> = {},
    resolver: Resolver = defaultResolver,
    hidden: string[] = [],
  ): Promise<Secrets> {
    const values: Record<string, string> = {};
    for (const [name, ref] of Object.entries(refs)) {
      try {
        values[name] = await resolver(ref);
      } catch (e) {
        throw new Error(`secret '${name}': ${(e as Error).message}`);
      }
    }
    // Longest first, so a secret containing another is fully masked.
    const sorted = [...Object.values(values), ...hidden]
      .filter((v) => v.length >= 4)
      .sort((a, b) => b.length - a.length);
    return new Secrets(values, sorted);
  }

  redact(text: string): string {
    let out = text;
    for (const s of this.sorted) out = out.split(s).join("***");
    return out;
  }
}
