import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../../scripts/oracle-geekez.sh", import.meta.url));
const dotsUrl = "https://chatgpt.com/dots/123e4567-e89b-12d3-a456-426614174000";
let fixture: string;
let runtime: string;

beforeEach(async () => {
  fixture = await mkdtemp(path.join(os.tmpdir(), "oracle-geekez-test-"));
  runtime = path.join(fixture, "runtime with spaces.mjs");
  await writeFile(runtime, "console.log(JSON.stringify(process.argv.slice(2)));\n");
  await writeFile(path.join(fixture, "curl"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
});

afterEach(async () => {
  await rm(fixture, { recursive: true, force: true });
});

function launch(args: string[], env: Record<string, string> = {}) {
  return spawnSync("bash", [script, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fixture}:${process.env.PATH ?? ""}`,
      ORACLE_GEEKEZ_PORT: "9333",
      ORACLE_GEEKEZ_ORACLE_BIN: "",
      ORACLE_GEEKEZ_DOTS_BIN: runtime,
      ORACLE_HOME_DIR: fixture,
      ...env,
    },
  });
}

describe("GeekEZ Oracle launcher", () => {
  it("routes a Dot to its separate runtime and preserves quoted prompt arguments", () => {
    const prompt = 'Keep literal $(echo secret), `echo secret`, and "quotes".';
    const result = launch([
      "--chatgpt-url",
      dotsUrl,
      "--slug",
      "dots-launcher-test",
      "--prompt",
      prompt,
    ]);
    expect(result.status, result.stderr).toBe(0);
    const argv = JSON.parse(result.stdout) as string[];
    expect(argv.slice(-6)).toEqual([
      "--chatgpt-url",
      dotsUrl,
      "--slug",
      "dots-launcher-test",
      "--prompt",
      prompt,
    ]);
    expect(argv.filter((arg) => arg === "--slug")).toHaveLength(1);
    expect(argv).toContain("127.0.0.1:9333");
    expect(argv).toContain("current");
  });

  it("recognizes the URL alias and supplies a default slug", () => {
    const result = launch([`--browser-url=${dotsUrl}`, "--prompt", "hello"]);
    expect(result.status, result.stderr).toBe(0);
    const argv = JSON.parse(result.stdout) as string[];
    const slug = argv[argv.indexOf("--slug") + 1];
    expect(slug).toMatch(/^geekez-oracle-\d{6}$/);
    expect(argv).toContain(`--browser-url=${dotsUrl}`);
  });

  it("recognizes canonicalizable Dots URLs without changing the supplied argument", () => {
    const url = `${dotsUrl.toUpperCase()}/?source=test#composer`;
    const result = launch(["--chatgpt-url", url, "--prompt", "hello"]);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toContain(url);
  });

  it("routes a saved Dot follow-up through the Dots runtime without requiring its URL again", async () => {
    const sessionDir = path.join(fixture, "sessions", "saved-dots-session");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      path.join(sessionDir, "meta.json"),
      JSON.stringify({
        browser: { runtime: { tabUrl: dotsUrl }, harvest: { url: dotsUrl } },
      }),
    );
    const result = launch(["--followup", "saved-dots-session", "--prompt", "continue"]);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toContain("saved-dots-session");
  });

  it("honors an explicit runtime override for ordinary ChatGPT calls", () => {
    const result = launch(["--prompt", "ordinary chat"], { ORACLE_GEEKEZ_ORACLE_BIN: runtime });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toContain("ordinary chat");
  });

  it("fails before touching the browser if the Dots runtime is missing", () => {
    const result = launch(["--chatgpt-url", dotsUrl, "--prompt", "hello"], {
      ORACLE_GEEKEZ_DOTS_BIN: path.join(fixture, "missing.js"),
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Oracle runtime not found");
    expect(result.stderr).not.toContain("GeekEZ profile Chrome on");
  });
});
