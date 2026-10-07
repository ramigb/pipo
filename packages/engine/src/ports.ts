// Port checks before a runner starts (docs/spec.md §7.2, D13, D30): is the port of an http input free, and if not,
// who holds it. The answer is advisory (another process may take the port between the check and the runner's bind;
// the runner's own bind error still stops it then), but it turns most "address in use" crashes into a clear refusal.
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { createServer } from "node:net";

/** Null when `host:port` can be bound right now; otherwise the error code (`EADDRINUSE`, `EACCES`, …). */
export function bindProblem(port: number, host = "127.0.0.1"): Promise<string | null> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", (e: NodeJS.ErrnoException) => resolve(e.code ?? e.message));
    server.listen({ port, host, exclusive: true }, () => server.close(() => resolve(null)));
  });
}

export interface PortHolder {
  pid: number;
  /** The holder's command line, shortened; empty when it can't be read. */
  command: string;
}

/**
 * The process listening on TCP `port`, from /proc (Linux only). Null when it can't be told: another platform, or a
 * process owned by another user (its file descriptors aren't readable).
 */
export function portHolder(port: number): PortHolder | null {
  const inodes = listeningInodes(port);
  if (!inodes.size) return null;
  let pids: string[];
  try {
    pids = readdirSync("/proc").filter((d) => /^\d+$/.test(d));
  } catch {
    return null;
  }
  for (const pid of pids) {
    let fds: string[];
    try {
      fds = readdirSync(`/proc/${pid}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      let target: string;
      try {
        target = readlinkSync(`/proc/${pid}/fd/${fd}`);
      } catch {
        continue;
      }
      const inode = /^socket:\[(\d+)\]$/.exec(target)?.[1];
      if (inode && inodes.has(inode)) return { pid: Number(pid), command: commandLine(Number(pid)) };
    }
  }
  return null;
}

/** Socket inodes in LISTEN state on `port`, any address, IPv4 or IPv6. */
function listeningInodes(port: number): Set<string> {
  const hex = `:${port.toString(16).toUpperCase().padStart(4, "0")}`;
  const found = new Set<string>();
  for (const table of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let text: string;
    try {
      text = readFileSync(table, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n").slice(1)) {
      const cols = line.trim().split(/\s+/);
      // local_address is cols[1], st is cols[3] (0A = LISTEN), inode is cols[9].
      if (cols[1]?.endsWith(hex) && cols[3] === "0A" && cols[9] && cols[9] !== "0") found.add(cols[9]);
    }
  }
  return found;
}

function commandLine(pid: number): string {
  try {
    const line = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean).join(" ");
    return line.length > 120 ? `${line.slice(0, 117)}...` : line;
  } catch {
    return "";
  }
}
