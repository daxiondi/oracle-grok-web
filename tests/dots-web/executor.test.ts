import { beforeEach, describe, expect, it, vi } from "vitest";
import { runInNewContext } from "node:vm";
import type { ProviderDomFlowContext } from "../../src/browser/providerDomFlow.js";
import type { BrowserRunOptions } from "../../src/browser/types.js";

const {
  closeTab,
  connectWithNewTab,
  resolveAttachRunningConnection,
  runProviderDomFlow,
  acquireBrowserTabLease,
  release,
  update,
  delay,
} = vi.hoisted(() => ({
  closeTab: vi.fn(async () => true),
  connectWithNewTab: vi.fn(),
  resolveAttachRunningConnection: vi.fn(),
  runProviderDomFlow: vi.fn(),
  acquireBrowserTabLease: vi.fn(),
  release: vi.fn(async () => undefined),
  update: vi.fn(async () => undefined),
  delay: vi.fn(async () => undefined),
}));

vi.mock("../../src/browser/chromeLifecycle.js", () => ({ closeTab, connectWithNewTab }));
vi.mock("../../src/browser/attachRunning.js", () => ({ resolveAttachRunningConnection }));
vi.mock("../../src/browser/providerDomFlow.js", () => ({ runProviderDomFlow }));
vi.mock("../../src/browser/providers/dotsDomProvider.js", () => ({
  dotsDomProvider: { providerName: "dots" },
}));
vi.mock("../../src/browser/tabLeaseRegistry.js", () => ({ acquireBrowserTabLease }));
vi.mock("../../src/browser/utils.js", () => ({ delay }));

const DOT_URL = "https://chatgpt.com/dots/123e4567-e89b-12d3-a456-426614174000";
const OTHER_DOT_URL = "https://chatgpt.com/dots/123e4567-e89b-12d3-a456-426614174001";
const REMOTE = { host: "127.0.0.1", port: 9333 };

function createClient() {
  return {
    Runtime: {
      enable: vi.fn(async () => undefined),
      evaluate: vi.fn(async ({ expression }: { expression: string }) => ({
        result: { value: expression === "window.location.href" ? DOT_URL : true },
      })),
    },
    Page: { enable: vi.fn(async () => undefined) },
    DOM: {
      enable: vi.fn(async () => undefined),
      getDocument: vi.fn(async () => ({ root: { nodeId: 1 } })),
      querySelector: vi.fn(async () => ({ nodeId: 7 })),
      setFileInputFiles: vi.fn(async () => undefined),
    },
    Input: { insertText: vi.fn(async () => undefined) },
    close: vi.fn(async () => undefined),
  };
}

function composerFixture(names: string[], status: string, pending: boolean, failed = false) {
  const remaining = [...names];
  return {
    get textContent() {
      return remaining.join("") + status;
    },
    querySelectorAll: () =>
      remaining.map((name) => ({
        textContent: name,
        remove: () => {
          remaining.splice(remaining.indexOf(name), 1);
        },
      })),
    querySelector: (selector: string) =>
      (selector.includes('data-upload-state="error"') ? failed : pending) ? {} : null,
    cloneNode: () => composerFixture(remaining, status, pending, failed),
  };
}

async function successfulFlow(_adapter: unknown, ctx: ProviderDomFlowContext) {
  await ctx.beforeSubmit?.();
  const attachments = ctx.state?.attachments as Array<{ path: string; name: string }>;
  if (attachments.length) await ctx.uploadAttachments?.(attachments);
  await (ctx.state!.insertText as (text: string) => Promise<void>)(ctx.prompt);
  await (ctx.state!.onPromptSubmitted as () => Promise<void>)();
  const originalPrompt = ctx.prompt.split("\n\nOracle completion protocol:\n")[0];
  return { text: `Answer for ${originalPrompt}`, html: `<p>${originalPrompt}</p>`, thoughts: null };
}

async function run(overrides: Partial<BrowserRunOptions> = {}) {
  const { createDotsWebExecutor } = await import("../../src/dots-web/executor.js");
  return createDotsWebExecutor()({
    prompt: "Review the task",
    config: { remoteChrome: REMOTE, chatgptUrl: DOT_URL },
    ...overrides,
  });
}

describe("Dots web executor", () => {
  let client: ReturnType<typeof createClient>;

  beforeEach(() => {
    vi.clearAllMocks();
    client = createClient();
    connectWithNewTab.mockResolvedValue({ client, targetId: "dots-target" });
    resolveAttachRunningConnection.mockResolvedValue(null);
    acquireBrowserTabLease.mockResolvedValue({ id: "dots-lease", release, update });
    runProviderDomFlow.mockImplementation(successfulFlow);
    delay.mockImplementation(async () => undefined);
  });

  it("isolates an attached Chrome tab, preserves the requested model as unverified and releases its Dot lease", async () => {
    const log = vi.fn();
    const result = await run({
      config: { remoteChrome: REMOTE, url: DOT_URL, desiredModel: "GPT-5.5 Pro" },
      log,
    });

    expect(acquireBrowserTabLease).toHaveBeenCalledWith(
      expect.stringContaining("browser-dots-locks"),
      expect.objectContaining({
        maxConcurrentTabs: 1,
        chromeHost: REMOTE.host,
        chromePort: REMOTE.port,
      }),
    );
    expect(connectWithNewTab).toHaveBeenCalledWith(
      9333,
      log,
      DOT_URL,
      "127.0.0.1",
      expect.objectContaining({ fallbackToDefault: false }),
    );
    expect(result).toMatchObject({
      answerText: "Answer for Review the task",
      answerMarkdown: "Answer for Review the task",
      answerHtml: "<p>Review the task</p>",
      answerChars: "Answer for Review the task".length,
      answerTokens: Math.ceil("Answer for Review the task".length / 4),
      chromeTargetId: "dots-target",
      tabUrl: DOT_URL,
      promptSubmitted: true,
      modelSelection: {
        strategy: "current",
        requestedModel: "GPT-5.5 Pro",
        resolvedLabel: null,
        status: "skipped",
        verified: false,
      },
    });
    expect(client.Input.insertText).toHaveBeenCalledWith({
      text: runProviderDomFlow.mock.calls[0][1].prompt,
    });
    const { prompt: sentPrompt, state } = runProviderDomFlow.mock.calls[0][1];
    expect(sentPrompt).toMatch(/^Review the task\n\nOracle completion protocol:\n/);
    expect(state.completionMarker).toMatch(/^ORACLE-DOTS-DONE-[0-9a-f]{32}$/);
    expect(sentPrompt).toContain(`\n${state.completionMarker}\n`);
    expect(sentPrompt).toContain("wait for all tools and their results");
    expect(sentPrompt).toContain(
      "Do not output this marker in progress messages, code blocks, quotes, or examples.",
    );
    expect(result.answerText).not.toContain("Oracle completion protocol");
    expect(result.answerMarkdown).not.toContain(state.completionMarker);
    expect(result.answerHtml).not.toContain(state.completionMarker);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("cannot be selected or verified"));
    expect(client.close).toHaveBeenCalledOnce();
    expect(closeTab).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it("persists target and submission evidence before waiting for the response", async () => {
    const hints: Array<Record<string, unknown>> = [];
    runProviderDomFlow.mockImplementation(async (_adapter, ctx: ProviderDomFlowContext) => {
      await ctx.beforeSubmit?.();
      expect(hints).toHaveLength(1);
      expect(hints[0]).toMatchObject({
        chromeTargetId: "dots-target",
        tabUrl: DOT_URL,
        promptSubmitted: false,
      });
      await (ctx.state!.onPromptSubmitted as () => Promise<void>)();
      expect(hints.at(-1)).toMatchObject({ promptSubmitted: true });
      throw new Error("Timed out waiting for Dots response");
    });
    await expect(
      run({
        runtimeHintCb: async (hint) => {
          hints.push(hint as Record<string, unknown>);
        },
        config: { remoteChrome: REMOTE, chatgptUrl: DOT_URL, keepBrowser: false },
      }),
    ).rejects.toThrow(/Timed out/);
    expect(runProviderDomFlow).toHaveBeenCalledOnce();
    expect(closeTab).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it("preserves caller prompt values while adding a unique private protocol to every submitted turn", async () => {
    const request = {
      prompt: "  Inspect this file.\nKeep the original wording.  ",
      followUpPrompts: ["  Check again.\nInclude evidence.  "],
    };
    const originalRequest = structuredClone(request);
    const result = await run(request);
    expect(request).toEqual(originalRequest);
    expect(
      runProviderDomFlow.mock.calls[0][1].prompt.startsWith(
        `${originalRequest.prompt}\n\nOracle completion protocol:\n`,
      ),
    ).toBe(true);
    expect(
      runProviderDomFlow.mock.calls[1][1].prompt.startsWith(
        `${originalRequest.followUpPrompts[0]}\n\nOracle completion protocol:\n`,
      ),
    ).toBe(true);
    expect(result.answerMarkdown).toContain(originalRequest.prompt.trim());
    expect(result.answerMarkdown).toContain(originalRequest.followUpPrompts[0].trim());
    expect(result.answerMarkdown).not.toContain("Oracle completion protocol");
    expect(result.answerMarkdown).not.toContain("ORACLE-DOTS-DONE-");
  });

  it("prefers the resume URL and canonicalizes the same Dot to the same lock", async () => {
    await run({
      config: {
        remoteChrome: REMOTE,
        chatgptUrl: OTHER_DOT_URL,
        resumeConversationUrl: `${DOT_URL}/?source=followup#latest`,
      },
    });
    const firstLock = acquireBrowserTabLease.mock.calls[0][0];
    await run();
    expect(acquireBrowserTabLease.mock.calls[1][0]).toBe(firstLock);
    expect(connectWithNewTab.mock.calls[0][2]).toBe(DOT_URL);
  });

  it("runs follow-ups in the same tab and attaches files only once", async () => {
    const result = await run({
      attachments: [{ path: "/tmp/review.txt", displayPath: "review.txt" }],
      followUpPrompts: ["Check the evidence", "Give the conclusion"],
    });
    expect(connectWithNewTab).toHaveBeenCalledOnce();
    expect(acquireBrowserTabLease).toHaveBeenCalledOnce();
    const originalPrompts = ["Review the task", "Check the evidence", "Give the conclusion"];
    const markers = runProviderDomFlow.mock.calls.map(([, ctx]) => ctx.state.completionMarker);
    expect(new Set(markers).size).toBe(3);
    runProviderDomFlow.mock.calls.forEach(([, ctx], index) => {
      expect(
        ctx.prompt.startsWith(`${originalPrompts[index]}\n\nOracle completion protocol:\n`),
      ).toBe(true);
      expect(markers[index]).toMatch(/^ORACLE-DOTS-DONE-[0-9a-f]{32}$/);
      expect(ctx.prompt).toContain(`\n${markers[index]}\n`);
      expect(markers.filter((marker) => ctx.prompt.includes(marker))).toEqual([markers[index]]);
    });
    expect(runProviderDomFlow.mock.calls.map(([, ctx]) => ctx.state.attachments)).toEqual([
      [{ path: "/tmp/review.txt", name: "review.txt" }],
      [],
      [],
    ]);
    expect(client.DOM.setFileInputFiles).toHaveBeenCalledOnce();
    const expectedTranscript = `## Initial response

### Prompt

Review the task

### Answer

Answer for Review the task

## Follow-up 1

### Prompt

Check the evidence

### Answer

Answer for Check the evidence

## Follow-up 2

### Prompt

Give the conclusion

### Answer

Answer for Give the conclusion`;
    expect(result.answerText).toBe(expectedTranscript);
    expect(result.answerMarkdown).toBe(expectedTranscript);
    expect(result.answerHtml).toBe("");
    expect(result.answerChars).toBe(expectedTranscript.length);
    expect(result.answerTokens).toBe(Math.ceil(expectedTranscript.length / 4));
    expect(result.answerText).not.toContain("Oracle completion protocol");
    for (const marker of markers) {
      expect(result.answerText).not.toContain(marker);
      expect(result.answerMarkdown).not.toContain(marker);
    }
    expect(release).toHaveBeenCalledOnce();
  });

  it("uses attach-running metadata without launching or closing Chrome", async () => {
    resolveAttachRunningConnection.mockResolvedValue({
      host: "127.0.0.1",
      port: 9444,
      browserWSEndpoint: "ws://browser",
      profileRoot: "/tmp/geekez",
    });
    const result = await run({ config: { attachRunning: true, url: DOT_URL, keepBrowser: false } });
    expect(resolveAttachRunningConnection).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      chromePort: 9444,
      chromeBrowserWSEndpoint: "ws://browser",
      chromeProfileRoot: "/tmp/geekez",
    });
    expect(closeTab).toHaveBeenCalledWith(9444, "dots-target", expect.any(Function), "127.0.0.1");
  });

  it("closes only its completed owned tab when the service requests it", async () => {
    await run({ closeOwnedTabOnComplete: true });
    expect(closeTab).toHaveBeenCalledWith(9333, "dots-target", expect.any(Function), "127.0.0.1");
  });

  it("releases the lease if isolated tab connection fails", async () => {
    connectWithNewTab.mockRejectedValueOnce(new Error("CDP unavailable"));
    await expect(run()).rejects.toThrow("CDP unavailable");
    expect(release).toHaveBeenCalledOnce();
    expect(closeTab).not.toHaveBeenCalled();
  });

  it("retains the isolated tab when runtime setup fails", async () => {
    client.Page.enable.mockRejectedValueOnce(new Error("Page unavailable"));
    await expect(
      run({ config: { remoteChrome: REMOTE, url: DOT_URL, keepBrowser: false } }),
    ).rejects.toThrow("Page unavailable");
    expect(client.close).toHaveBeenCalledOnce();
    expect(closeTab).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it("rejects redirected or different Dot pages before typing", async () => {
    client.Runtime.evaluate.mockResolvedValue({ result: { value: OTHER_DOT_URL } });
    await expect(run()).rejects.toThrow(/left the requested conversation/);
    expect(client.Input.insertText).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it("does not submit if attachments have no composer readiness proof", async () => {
    client.Runtime.evaluate.mockImplementation(async ({ expression }: { expression: string }) => ({
      result: { value: expression === "window.location.href" ? DOT_URL : false },
    }));
    await expect(
      run({
        attachments: [{ path: "/tmp/a.txt", displayPath: "a.txt" }],
        config: { remoteChrome: REMOTE, url: DOT_URL, attachmentTimeoutMs: 0 },
      }),
    ).rejects.toThrow(/attachments to finish uploading/);
    expect(client.Input.insertText).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it("scopes upload readiness to current composer files and pending states", async () => {
    await run({ attachments: [{ path: "/tmp/a.txt", displayPath: "a.txt" }] });
    const readinessExpression = client.Runtime.evaluate.mock.calls
      .map(([args]) => args.expression)
      .find((expression) => expression.includes("data-composer-attachments"));
    expect(readinessExpression).toContain('data-upload-state="uploading"');
    expect(readinessExpression).toContain('role="progressbar"');
    expect(readinessExpression).not.toContain("document.body");
    expect(readinessExpression).not.toContain(".files");
  });

  it.each([
    { label: "ready exact file", files: ["a.txt"], status: "", pending: false, ready: true },
    {
      label: "name containing status word",
      files: ["processing-guide.txt"],
      status: "",
      pending: false,
      ready: true,
      expectedName: "processing-guide.txt",
    },
    {
      label: "colliding suffix filename",
      files: ["data.txt"],
      status: "",
      pending: false,
      ready: false,
    },
    { label: "pending spinner", files: ["a.txt"], status: "", pending: true, ready: false },
    { label: "upload status", files: ["a.txt"], status: "正在上传", pending: false, ready: false },
    {
      label: "processing status",
      files: ["a.txt"],
      status: "Processing",
      pending: false,
      ready: false,
    },
    { label: "upload error", files: ["a.txt"], status: "上传失败", pending: false, ready: false },
    { label: "file present only in history", files: [], status: "", pending: false, ready: false },
  ])("validates the actual attachment readiness script: $label", async (fixture) => {
    vi.useFakeTimers();
    delay.mockImplementation(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    const scope = composerFixture(fixture.files, fixture.status, fixture.pending);
    client.Runtime.evaluate.mockImplementation(async ({ expression }: { expression: string }) => ({
      result: {
        value:
          expression === "window.location.href"
            ? DOT_URL
            : runInNewContext(expression, {
                document: {
                  body: { innerText: "Historical a.txt" },
                  querySelector: (selector: string) =>
                    selector === "[data-composer-attachments]" ? scope : null,
                },
              }),
      },
    }));
    try {
      const expectedName = fixture.expectedName ?? "a.txt";
      const pendingRun = run({
        attachments: [{ path: `/tmp/${expectedName}`, displayPath: expectedName }],
        config: { remoteChrome: REMOTE, url: DOT_URL, attachmentTimeoutMs: 500 },
      });
      if (fixture.ready) {
        await expect(pendingRun).resolves.toMatchObject({ promptSubmitted: true });
        expect(client.Input.insertText).toHaveBeenCalledOnce();
      } else {
        await expect(pendingRun).rejects.toThrow(/attachments to finish uploading/);
        expect(client.Input.insertText).not.toHaveBeenCalled();
      }
      expect(release).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    { modelStrategy: "select" },
    { modelStrategy: "ignore" },
    { thinkingTime: "heavy" },
    { researchMode: "deep" },
    { copyProfileSource: "/tmp/profile" },
    { browserTabRef: "user-owned-tab" },
    { archiveConversations: "always" },
  ] as Array<Partial<NonNullable<BrowserRunOptions["config"]>>>)(
    "rejects unsupported config %j before connecting",
    async (extra) => {
      await expect(
        run({ config: { remoteChrome: REMOTE, url: DOT_URL, ...extra } }),
      ).rejects.toThrow(/does not support|browser-model-strategy current/);
      expect(connectWithNewTab).not.toHaveBeenCalled();
      expect(acquireBrowserTabLease).not.toHaveBeenCalled();
    },
  );

  it("rejects image generation before connecting", async () => {
    await expect(run({ generateImagePath: "/tmp/image.png" })).rejects.toThrow(/does not support/);
    expect(connectWithNewTab).not.toHaveBeenCalled();
  });

  it("uses the primary prompt without sending the automatic fallback", async () => {
    const log = vi.fn();
    await run({
      log,
      fallbackSubmission: {
        prompt: "Fallback prompt",
        attachments: [{ path: "/tmp/fallback.txt", displayPath: "fallback.txt" }],
      },
    });
    expect(runProviderDomFlow).toHaveBeenCalledOnce();
    expect(client.Input.insertText).toHaveBeenCalledWith({
      text: runProviderDomFlow.mock.calls[0][1].prompt,
    });
    expect(
      runProviderDomFlow.mock.calls[0][1].prompt.startsWith(
        "Review the task\n\nOracle completion protocol:\n",
      ),
    ).toBe(true);
    expect(runProviderDomFlow.mock.calls[0][1].prompt).not.toContain("Fallback prompt");
    expect(client.DOM.setFileInputFiles).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("will not be resent"));
  });

  it("rejects navigation during response polling instead of reading another Dot", async () => {
    runProviderDomFlow.mockImplementation(async (_adapter, ctx: ProviderDomFlowContext) => {
      await ctx.beforeSubmit?.();
      await (ctx.state!.onPromptSubmitted as () => Promise<void>)();
      client.Runtime.evaluate.mockResolvedValue({ result: { value: OTHER_DOT_URL } });
      await ctx.evaluate("document.querySelector('article.message-row')?.textContent");
      return { text: "wrong answer" };
    });
    await expect(run()).rejects.toThrow(/left the requested conversation/);
    expect(client.Runtime.evaluate.mock.calls.at(-1)?.[0].expression).toBe("window.location.href");
    expect(closeTab).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it.each([{}, { url: "https://chatgpt.com/" }, { resumeConversationUrl: "", url: DOT_URL }])(
    "requires an explicit valid Dot target %j",
    async (extra) => {
      await expect(run({ config: { remoteChrome: REMOTE, ...extra } })).rejects.toThrow(
        /Invalid Dots conversation URL/,
      );
      expect(connectWithNewTab).not.toHaveBeenCalled();
      expect(acquireBrowserTabLease).not.toHaveBeenCalled();
    },
  );

  it("requires an existing Chrome session", async () => {
    await expect(run({ config: { url: DOT_URL } })).rejects.toThrow(/requires --remote-chrome/);
    expect(connectWithNewTab).not.toHaveBeenCalled();
  });
});
