import { beforeEach, describe, expect, it, vi } from "vitest";

const { closeTab, connectWithNewTab, resolveAttachRunningConnection, delay } = vi.hoisted(() => ({
  closeTab: vi.fn(async () => true),
  connectWithNewTab: vi.fn(),
  resolveAttachRunningConnection: vi.fn(),
  delay: vi.fn(async () => undefined),
}));

vi.mock("../../src/browser/chromeLifecycle.js", () => ({ closeTab, connectWithNewTab }));
vi.mock("../../src/browser/attachRunning.js", () => ({ resolveAttachRunningConnection }));
vi.mock("../../src/browser/utils.js", () => ({ delay }));

function createClient(evaluate: ReturnType<typeof vi.fn>, overrides: Record<string, unknown> = {}) {
  return {
    Runtime: { enable: vi.fn(async () => undefined), evaluate },
    Page: { enable: vi.fn(async () => undefined) },
    DOM: { enable: vi.fn(async () => undefined), ...overrides },
    close: vi.fn(async () => undefined),
  };
}

describe("Manus web executor", () => {
  beforeEach(() => {
    closeTab.mockClear();
    connectWithNewTab.mockReset();
    resolveAttachRunningConnection.mockReset();
    delay.mockClear();
  });

  it("submits a text prompt and returns a stable Manus response", async () => {
    let responsePoll = 0;
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression.includes("const nodes = Array.from")) return { result: { value: 0 } };
      if (expression.includes("ready:")) {
        return { result: { value: { ready: true, blocked: false } } };
      }
      if (expression.includes("const value =")) return { result: { value: "typed" } };
      if (expression.includes("const button = Array.from")) return { result: { value: "clicked" } };
      if (expression.includes("const all = Array.from")) {
        responsePoll += 1;
        return {
          result: {
            value: JSON.stringify({
              status: responsePoll === 1 ? "streaming" : "idle",
              text: "Manus answer",
              html: "<p>Manus answer</p>",
            }),
          },
        };
      }
      if (expression.includes("window.location.href")) {
        return { result: { value: "https://manus.im/" } };
      }
      return { result: { value: null } };
    });
    connectWithNewTab.mockResolvedValue({
      client: createClient(evaluate),
      targetId: "manus-target",
    });

    const { createManusWebExecutor } = await import("../../src/manus-web/executor.js");
    const result = await createManusWebExecutor()({
      prompt: "Test prompt",
      config: { remoteChrome: { host: "127.0.0.1", port: 9333 }, keepBrowser: true },
      log: () => {},
    });

    expect(connectWithNewTab).toHaveBeenCalledWith(
      9333,
      expect.any(Function),
      "https://manus.im/",
      "127.0.0.1",
      expect.objectContaining({ fallbackToDefault: false }),
    );
    expect(result.answerText).toBe("Manus answer");
    expect(result.answerHtml).toBe("<p>Manus answer</p>");
    expect(result.chromeTargetId).toBe("manus-target");
    expect(result.promptSubmitted).toBe(true);
    expect(closeTab).not.toHaveBeenCalled();
  });

  it("opens an explicit Manus conversation URL for a follow-up run", async () => {
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression.includes("const nodes = Array.from")) return { result: { value: 0 } };
      if (expression.includes("ready:")) return { result: { value: { ready: true } } };
      if (expression.includes("const value =")) return { result: { value: "typed" } };
      if (expression.includes("const button = Array.from")) return { result: { value: "clicked" } };
      if (expression.includes("const all = Array.from")) {
        return { result: { value: JSON.stringify({ status: "idle", text: "follow-up done" }) } };
      }
      if (expression.includes("window.location.href")) {
        return {
          result: { value: "https://manus.im/app/j5Lk2cHyXhhSMcLUHlDmO5" },
        };
      }
      return { result: { value: null } };
    });
    connectWithNewTab.mockResolvedValue({
      client: createClient(evaluate),
      targetId: "manus-follow-up-target",
    });

    const { createManusWebExecutor } = await import("../../src/manus-web/executor.js");
    const result = await createManusWebExecutor()({
      prompt: "Continue the existing task",
      config: {
        remoteChrome: { host: "127.0.0.1", port: 9333 },
        resumeConversationUrl: "https://manus.im/app/j5Lk2cHyXhhSMcLUHlDmO5",
      },
    });

    expect(connectWithNewTab).toHaveBeenCalledWith(
      9333,
      expect.any(Function),
      "https://manus.im/app/j5Lk2cHyXhhSMcLUHlDmO5",
      "127.0.0.1",
      expect.objectContaining({ fallbackToDefault: false }),
    );
    expect(result.tabUrl).toBe("https://manus.im/app/j5Lk2cHyXhhSMcLUHlDmO5");
  });

  it("uses a configured Manus URL and rejects an invalid resume URL", async () => {
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression.includes("const nodes = Array.from")) return { result: { value: 0 } };
      if (expression.includes("ready:")) return { result: { value: { ready: true } } };
      if (expression.includes("const value =")) return { result: { value: "typed" } };
      if (expression.includes("const button = Array.from")) return { result: { value: "clicked" } };
      if (expression.includes("const all = Array.from")) {
        return { result: { value: JSON.stringify({ status: "idle", text: "done" }) } };
      }
      return { result: { value: null } };
    });
    connectWithNewTab.mockResolvedValue({
      client: createClient(evaluate),
      targetId: "manus-configured-target",
    });

    const { createManusWebExecutor } = await import("../../src/manus-web/executor.js");
    await createManusWebExecutor()({
      prompt: "Use this conversation",
      config: {
        remoteChrome: { host: "127.0.0.1", port: 9333 },
        url: "https://manus.im/app/j5Lk2cHyXhhSMcLUHlDmO5",
      },
    });
    expect(connectWithNewTab).toHaveBeenCalledWith(
      9333,
      expect.any(Function),
      "https://manus.im/app/j5Lk2cHyXhhSMcLUHlDmO5",
      "127.0.0.1",
      expect.objectContaining({ fallbackToDefault: false }),
    );

    await expect(
      createManusWebExecutor()({
        prompt: "Reject this",
        config: {
          remoteChrome: { host: "127.0.0.1", port: 9333 },
          resumeConversationUrl: "https://chatgpt.com/c/not-manus",
        },
      }),
    ).rejects.toThrow(/Invalid Manus conversation URL/);
  });

  it("uses an attached running Chrome profile and closes the tab when requested", async () => {
    resolveAttachRunningConnection.mockResolvedValue({
      host: "127.0.0.1",
      port: 9444,
      browserWSEndpoint: "ws://browser",
      profileRoot: "/tmp/profile",
    });
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression.includes("const nodes = Array.from")) return { result: { value: 0 } };
      if (expression.includes("ready:")) return { result: { value: { ready: true } } };
      if (expression.includes("const value =")) return { result: { value: "typed" } };
      if (expression.includes("const button = Array.from")) return { result: { value: "clicked" } };
      if (expression.includes("const all = Array.from")) {
        return { result: { value: JSON.stringify({ status: "idle", text: "done" }) } };
      }
      return { result: { value: null } };
    });
    connectWithNewTab.mockResolvedValue({
      targetId: "target-2",
      client: createClient(evaluate),
    });

    const { createManusWebExecutor } = await import("../../src/manus-web/executor.js");
    const result = await createManusWebExecutor()({
      prompt: "Test prompt",
      config: { attachRunning: true, keepBrowser: false },
    });

    expect(resolveAttachRunningConnection).toHaveBeenCalled();
    expect(result.chromeBrowserWSEndpoint).toBe("ws://browser");
    expect(closeTab).toHaveBeenCalledWith(9444, "target-2", expect.any(Function), "127.0.0.1");
  });

  it("uploads local files before submitting the prompt", async () => {
    const setFileInputFiles = vi.fn(async () => undefined);
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression.includes("const nodes = Array.from")) return { result: { value: 0 } };
      if (expression.includes("ready:")) return { result: { value: { ready: true } } };
      if (expression.includes("if (document.querySelector('input[type=\\\"file\\\"]'))")) {
        return { result: { value: "input" } };
      }
      if (expression.includes("const chips =")) return { result: { value: true } };
      if (expression.includes("const value =")) return { result: { value: "typed" } };
      if (expression.includes("const button = Array.from")) return { result: { value: "clicked" } };
      if (expression.includes("const all = Array.from")) {
        return { result: { value: JSON.stringify({ status: "idle", text: "file answer" }) } };
      }
      return { result: { value: null } };
    });
    connectWithNewTab.mockResolvedValue({
      targetId: "target-upload",
      client: createClient(evaluate, {
        getDocument: vi.fn(async () => ({ root: { nodeId: 1 } })),
        querySelector: vi.fn(async () => ({ nodeId: 7 })),
        setFileInputFiles,
      }),
    });

    const { createManusWebExecutor } = await import("../../src/manus-web/executor.js");
    const result = await createManusWebExecutor()({
      prompt: "Review this file",
      attachments: [{ path: "/tmp/a.txt", displayPath: "a.txt" }],
      config: { remoteChrome: { host: "127.0.0.1", port: 9333 } },
    });

    expect(setFileInputFiles).toHaveBeenCalledWith({ nodeId: 7, files: ["/tmp/a.txt"] });
    expect(result.answerText).toBe("file answer");
  });

  it("keeps follow-up prompts in the same Manus tab", async () => {
    let responseCount = 0;
    let responsePoll = 0;
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression.includes("const nodes = Array.from")) {
        return { result: { value: responseCount++ } };
      }
      if (expression.includes("ready:")) return { result: { value: { ready: true } } };
      if (expression.includes("const value =")) return { result: { value: "typed" } };
      if (expression.includes("const button = Array.from")) {
        responsePoll += 1;
        return { result: { value: "clicked" } };
      }
      if (expression.includes("const all = Array.from")) {
        return {
          result: {
            value: JSON.stringify({
              status: "idle",
              text: responsePoll > 1 ? "follow-up answer" : "first answer",
            }),
          },
        };
      }
      return { result: { value: null } };
    });
    connectWithNewTab.mockResolvedValue({
      targetId: "target-follow-up",
      client: createClient(evaluate),
    });

    const { createManusWebExecutor } = await import("../../src/manus-web/executor.js");
    const result = await createManusWebExecutor()({
      prompt: "First prompt",
      followUpPrompts: ["Second prompt"],
      config: { remoteChrome: { host: "127.0.0.1", port: 9333 } },
    });

    expect(connectWithNewTab).toHaveBeenCalledTimes(1);
    expect(result.answerText).toBe("follow-up answer");
    expect(
      evaluate.mock.calls.filter(([arg]) => arg.expression.includes("const value =")),
    ).toHaveLength(2);
  });

  it("reports a missing Manus sign-in instead of waiting for the full timeout", async () => {
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression.includes("ready:")) return { result: { value: { ready: true } } };
      if (expression.includes("const value =")) return { result: { value: "typed" } };
      if (expression.includes("const button = Array.from")) return { result: { value: "clicked" } };
      if (expression.includes("const all = Array.from")) {
        return { result: { value: JSON.stringify({ status: "login-required" }) } };
      }
      return { result: { value: 0 } };
    });
    connectWithNewTab.mockResolvedValue({
      targetId: "target-login",
      client: createClient(evaluate),
    });

    const { createManusWebExecutor } = await import("../../src/manus-web/executor.js");
    await expect(
      createManusWebExecutor()({
        prompt: "Test prompt",
        config: { remoteChrome: { host: "127.0.0.1", port: 9333 } },
      }),
    ).rejects.toThrow(/requires sign-in/);
  });
});
