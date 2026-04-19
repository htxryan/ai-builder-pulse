// DA-S-02 / DA-S-03 — DeepAgents must NOT be in the module graph when the
// factory picks mock or legacy.
//
// Strategy: spawn a child node process with a registered loader hook that
// records every resolved specifier to a file. The probe calls
// `selectCurator`, then the test reads the file and checks that no
// LangChain / DeepAgents specifiers were resolved for the mock / legacy
// paths. As a sanity check, the default Claude path MUST resolve them.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");
const LOADER_PATH = resolve(HERE, "__fixtures__/record-loader.mjs");

let tmpDir: string;
let recordPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "deepagent-lazyload-"));
  recordPath = join(tmpDir, "specifiers.log");
  writeFileSync(recordPath, "");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function runProbe(env: Record<string, string>): {
  specifiers: string[];
  curator: string;
  status: number;
  stderr: string;
  stdout: string;
} {
  const probe = `
    const { selectCurator } = await import(${JSON.stringify(`${REPO_ROOT}/src/curator/index.ts`)});
    const c = await selectCurator(process.env, {
      runId: "rid", runDate: "2026-04-19",
    });
    process.stdout.write("__RESULT__" + (c && c.constructor && c.constructor.name || "null"));
  `;
  const registerHook = `data:text/javascript,import { register } from "node:module"; register(${JSON.stringify(`file://${LOADER_PATH}`)}, import.meta.url);`;
  const result = spawnSync(
    "node",
    [
      "--no-warnings",
      "--import",
      "tsx",
      "--import",
      registerHook,
      "--input-type=module",
      "-e",
      probe,
    ],
    {
      env: {
        ...process.env,
        ...env,
        LOADER_RECORD_PATH: recordPath,
      },
      cwd: REPO_ROOT,
      encoding: "utf8",
    },
  );

  let curator = "";
  const out = result.stdout ?? "";
  const m = out.match(/__RESULT__(\S+)/);
  if (m) curator = m[1]!;

  let specifiers: string[] = [];
  try {
    specifiers = readFileSync(recordPath, "utf8")
      .split("\n")
      .filter(Boolean);
  } catch {
    /* empty */
  }

  return {
    specifiers,
    curator,
    status: result.status ?? -1,
    stderr: result.stderr ?? "",
    stdout: out,
  };
}

function offenders(specifiers: string[]): string[] {
  return specifiers.filter(
    (s) =>
      s.includes("/deepagents/") ||
      s.includes("/@langchain/langgraph/") ||
      s.includes("/@langchain/anthropic/") ||
      s.includes("/@langchain/core/") ||
      s.includes("/curator/deepagent/"),
  );
}

describe("selectCurator lazy-load contract (DA-S-02 / DA-S-03)", () => {
  it(
    "CURATOR=mock — DeepAgents + @langchain modules not loaded",
    { timeout: 60_000 },
    () => {
      const r = runProbe({ CURATOR: "mock" });
      expect(r.status, `stderr=${r.stderr}\nstdout=${r.stdout}`).toBe(0);
      expect(r.curator).toBe("MockCurator");
      const bad = offenders(r.specifiers);
      expect(bad, bad.join("\n")).toEqual([]);
    },
  );

  it(
    "CURATOR=claude (default backend) — DeepAgents not loaded",
    { timeout: 60_000 },
    () => {
      const r = runProbe({
        CURATOR: "claude",
        ANTHROPIC_API_KEY: "sk-test",
      });
      expect(r.status, `stderr=${r.stderr}\nstdout=${r.stdout}`).toBe(0);
      expect(r.curator).toBe("ClaudeCurator");
      const bad = offenders(r.specifiers);
      expect(bad, bad.join("\n")).toEqual([]);
    },
  );

  it(
    "CURATOR=claude + CURATOR_BACKEND=legacy — DeepAgents not loaded",
    { timeout: 60_000 },
    () => {
      const r = runProbe({
        CURATOR: "claude",
        CURATOR_BACKEND: "legacy",
        ANTHROPIC_API_KEY: "sk-test",
      });
      expect(r.status, `stderr=${r.stderr}\nstdout=${r.stdout}`).toBe(0);
      expect(r.curator).toBe("ClaudeCurator");
      const bad = offenders(r.specifiers);
      expect(bad, bad.join("\n")).toEqual([]);
    },
  );

  it(
    "CURATOR_BACKEND=deepagents — DeepAgents IS loaded (sanity)",
    { timeout: 60_000 },
    () => {
      // M1 sanity: the DeepAgents adapter module itself is in the graph.
      // Tightening to assert `@langchain/*` specifiers also appear will
      // come with M2 when the adapter actually imports LangGraph.
      const r = runProbe({
        CURATOR: "claude",
        CURATOR_BACKEND: "deepagents",
      });
      expect(r.status, `stderr=${r.stderr}\nstdout=${r.stdout}`).toBe(0);
      expect(r.curator).toBe("DeepAgentCurator");
      const loaded = r.specifiers.some((s) =>
        s.includes("/curator/deepagent/"),
      );
      expect(loaded).toBe(true);
    },
  );
});
