import { describe, expect, test } from "vitest";
import { resolveRunOptionsFromConfig } from "../../src/cli/runOptions.js";

describe("resolveRunOptionsFromConfig Manus routing", () => {
  test("forces Manus to the browser engine even when an API key is present", () => {
    const result = resolveRunOptionsFromConfig({
      prompt: "hello",
      model: "manus",
      env: { OPENAI_API_KEY: "present" },
    });

    expect(result.resolvedEngine).toBe("browser");
    expect(result.runOptions.model).toBe("manus");
  });

  test.each([
    { engine: "api" as const, env: {} },
    { engine: undefined, env: { ORACLE_ENGINE: "api" } },
  ])("rejects explicit API routing for Manus", ({ engine, env }) => {
    expect(() =>
      resolveRunOptionsFromConfig({ prompt: "hello", model: "manus", engine, env }),
    ).toThrow(/Manus is browser-only/);
  });

  test("rejects Manus in a multi-model request", () => {
    expect(() =>
      resolveRunOptionsFromConfig({
        prompt: "hello",
        models: ["gpt-5.5", "manus"],
        engine: "api",
        env: {},
      }),
    ).toThrow(/cannot be combined with --models/);
  });
});
