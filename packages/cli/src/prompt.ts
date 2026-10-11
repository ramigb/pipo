// Reading a secret from the terminal without echoing it (`pipo owner reset`, D84), or from stdin when piped.
import { CliError } from "./errors";

/** Ask `question` on stderr and read one line from the terminal, not echoed. Ctrl-C cancels. */
export function askHidden(question: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY)
    throw new CliError(
      "there is no terminal to type the password in",
      "pipe it in instead: printf '%s' \"$PASSWORD\" | pipo owner reset --password-stdin",
      "bad_request",
    );
  process.stderr.write(question);
  stdin.setRawMode(true);
  stdin.setEncoding("utf8");
  stdin.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write("\n");
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") {
          finish();
          resolve(value);
          return;
        }
        if (ch === "\u0003") {
          finish();
          reject(new CliError("cancelled", "nothing was changed", "cancelled"));
          return;
        }
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else if (ch === "\u0015") value = "";
        else if (ch >= " ") value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

/** Everything on stdin, without the final line break (`--password-stdin`). */
export async function readStdinSecret(): Promise<string> {
  return (await Bun.stdin.text()).replace(/\r?\n$/, "");
}
