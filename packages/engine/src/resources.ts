// Resource use of each runner for the task manager (docs/spec.md §8, D68): CPU and memory of its whole process
// tree (CLI agents run as child processes), from one `ps` call. Works on Linux and macOS.

export interface Resources {
  /** Percent of one core, summed over the tree (so it can pass 100). */
  cpu: number;
  /** Resident memory in bytes, summed over the tree. */
  rss: number;
  /** Processes in the tree, the runner included. */
  procs: number;
}

/** Sum `ps -A -o pid=,ppid=,pcpu=,rss=` output (rss in KiB) over each root pid's tree. A gone pid is absent. */
export function sumTrees(psOut: string, roots: number[]): Map<number, Resources> {
  const kids = new Map<number, number[]>();
  const own = new Map<number, { cpu: number; rss: number }>();
  for (const line of psOut.split("\n")) {
    const [pid, ppid, cpu, rss] = line.trim().split(/\s+/).map(Number);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    own.set(pid as number, { cpu: cpu || 0, rss: (rss || 0) * 1024 });
    const list = kids.get(ppid as number);
    if (list) list.push(pid as number);
    else kids.set(ppid as number, [pid as number]);
  }
  const out = new Map<number, Resources>();
  for (const root of roots) {
    if (!own.has(root)) continue;
    const r = { cpu: 0, rss: 0, procs: 0 };
    const seen = new Set<number>();
    const stack = [root];
    while (stack.length) {
      const pid = stack.pop() as number;
      if (seen.has(pid)) continue;
      seen.add(pid);
      const p = own.get(pid);
      if (!p) continue;
      r.cpu += p.cpu;
      r.rss += p.rss;
      r.procs++;
      stack.push(...(kids.get(pid) ?? []));
    }
    r.cpu = Math.round(r.cpu * 10) / 10;
    out.set(root, r);
  }
  return out;
}

// ponytail: `ps` %cpu is a decaying average on macOS but the lifetime average on Linux; sample cputime deltas if
// Linux numbers need to be "right now". spawnSync blocks the gateway for the few ms `ps` takes (no pipe to hang on).
export function resourcesOf(pids: number[]): Map<number, Resources> {
  if (!pids.length) return new Map();
  try {
    const r = Bun.spawnSync(["ps", "-A", "-o", "pid=,ppid=,pcpu=,rss="], { stderr: "ignore" });
    return sumTrees(r.stdout.toString(), pids);
  } catch {
    return new Map();
  }
}
