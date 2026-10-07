import { expect, test } from "bun:test";
import { cliHint } from "../src/errors";

test("engine API hints are reworded for the CLI", () => {
  expect(cliHint("GET /api/pipelines lists them; start one with POST /api/pipelines {file} (pipo start <file>)")).toBe(
    "run 'pipo status' to list pipelines, or 'pipo start <file>'",
  );
  expect(cliHint("check its state with GET /api/pipelines/p1, then try again")).toBe(
    "check its state with 'pipo status p1', then try again",
  );
  expect(cliHint("send its packets with pipo push p1, or POST /api/pipelines/p1/push")).toBe(
    "send its packets with 'pipo push p1'",
  );
  expect(cliHint("fix the file")).toBe("fix the file");
  expect(cliHint(undefined)).toBeUndefined();
});
