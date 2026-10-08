import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { resolveAttachRunningConnection } from "../browser/attachRunning.js";
import { closeTab, connectWithNewTab } from "../browser/chromeLifecycle.js";
import { runProviderDomFlow } from "../browser/providerDomFlow.js";
import { dotsDomProvider } from "../browser/providers/dotsDomProvider.js";
import { acquireBrowserTabLease, type BrowserTabLease } from "../browser/tabLeaseRegistry.js";
import {
  formatBrowserTurnTranscript,
  type BrowserConversationTurn,
} from "../browser/turnTranscript.js";
import type {
  BrowserLogger,
  BrowserRunOptions,
  BrowserRunResult,
  ChromeClient,
} from "../browser/types.js";
import { delay } from "../browser/utils.js";
import { getOracleHomeDir } from "../oracleHome.js";
import type { BrowserModelSelectionEvidence, BrowserRuntimeMetadata } from "../sessionStore.js";
import { normalizeDotsConversationUrl } from "./url.js";

function resolveTargetUrl(config: BrowserRunOptions["config"]): string {
  const candidate = config?.resumeConversationUrl ?? config?.chatgptUrl ?? config?.url;
  const target = normalizeDotsConversationUrl(candidate);
  if (!target) {
    throw new Error(
      "Invalid Dots conversation URL. Pass an explicit https://chatgpt.com/dots/<uuid> link.",
    );
  }
  return target;
}

function assertSupportedOptions(options: BrowserRunOptions): void {
  const config = options.config;
  if (config?.modelStrategy && config.modelStrategy !== "current") {
    throw new Error("Dots cannot select or verify a model. Use --browser-model-strategy current.");
  }
  const unsupported = [
    config?.thinkingTime !== undefined && "--browser-thinking-time",
    config?.researchMode === "deep" && "--browser-research deep",
    options.generateImagePath !== undefined && "--generate-image",
    Boolean(config?.copyProfileSource) && "--copy-profile",
    Boolean(config?.browserTabRef) && "--browser-tab",
    config?.archiveConversations === "always" && "--browser-archive always",
  ].filter(Boolean);
  if (unsupported.length > 0) {
    throw new Error(`Dots web mode does not support: ${unsupported.join(", ")}.`);
  }
  if (!config?.remoteChrome && !config?.attachRunning) {
    throw new Error(
      "Dots web mode requires --remote-chrome or --browser-attach-running with a signed-in Chrome profile.",
    );
  }
}

export function createDotsWebExecutor(): (options: BrowserRunOptions) => Promise<BrowserRunResult> {
  return async (options) => {
    const startedAt = Date.now();
    const config = options.config;
    const logger: BrowserLogger = options.log ?? (() => {});
    assertSupportedOptions(options);
    const targetUrl = resolveTargetUrl(config);
    const attached = config?.attachRunning
      ? await resolveAttachRunningConnection(
          { chromePath: config.chromePath ?? null, remoteChrome: config.remoteChrome ?? null },
          logger,
        )
      : null;
    const remoteChrome = config?.remoteChrome ?? attached;
    if (!remoteChrome) throw new Error("Unable to resolve the attached Chrome endpoint.");
    const { host, port } = remoteChrome;
    const modelSelection: BrowserModelSelectionEvidence = {
      requestedModel: config?.desiredModel ?? null,
      resolvedLabel: null,
      strategy: "current",
      status: "skipped",
      verified: false,
      source: "config",
      capturedAt: new Date().toISOString(),
    };
    logger(
      "[dots-web] Using this Dot's current model. The Dot model cannot be selected or verified; no Pro model claim is made.",
    );
    if (options.fallbackSubmission) {
      logger(
        "[dots-web] Using the primary prompt and attachments. Automatic fallback submission is unavailable for Dots; failed submissions will not be resent.",
      );
    }
    const lockDir = path.join(
      getOracleHomeDir(),
      "browser-dots-locks",
      createHash("sha256").update(targetUrl).digest("hex"),
    );
    let lease: BrowserTabLease | null = null;
    let client: ChromeClient | null = null;
    let targetId: string | undefined;
    let tabUrl = targetUrl;
    let promptSubmitted = false;
    let complete = false;
    const runtime = (): BrowserRuntimeMetadata => ({
      browserTransport: "cdp",
      chromeHost: host,
      chromePort: port,
      chromeBrowserWSEndpoint:
        attached?.browserWSEndpoint ?? config?.remoteChromeBrowserWSEndpoint ?? undefined,
      chromeProfileRoot: attached?.profileRoot ?? config?.remoteChromeProfileRoot ?? undefined,
      chromeTargetId: targetId,
      tabUrl,
      promptSubmitted,
      controllerPid: process.pid,
    });
    const emitRuntimeHint = async () => {
      await lease?.update({ chromeTargetId: targetId, tabUrl });
      await options.runtimeHintCb?.(runtime(), modelSelection);
    };
    try {
      await mkdir(lockDir, { recursive: true });
      lease = await acquireBrowserTabLease(lockDir, {
        maxConcurrentTabs: 1,
        timeoutMs: config?.profileLockTimeoutMs ?? config?.timeoutMs ?? 20 * 60_000,
        logger,
        sessionId: options.sessionId,
        chromeHost: host,
        chromePort: port,
      });
      logger("[dots-web] Opening an isolated Dots tab in the attached Chrome session.");
      const connection = await connectWithNewTab(port, logger, targetUrl, host, {
        fallbackToDefault: false,
        retries: 2,
        retryDelayMs: 500,
      });
      client = connection.client;
      targetId = connection.targetId;
      if (!targetId) throw new Error("Dots requires an isolated Chrome tab with a target ID.");
      await emitRuntimeHint();
      await client.Runtime.enable();
      await client.Page.enable();
      await client.DOM.enable();
      const connectedClient = client;
      let confirmedDot = false;
      const rawEvaluate = async <T>(expression: string): Promise<T | undefined> => {
        const { result, exceptionDetails } = await connectedClient.Runtime.evaluate({
          expression,
          returnByValue: true,
        });
        if (exceptionDetails || result?.subtype === "error") {
          throw new Error(
            result?.description ?? exceptionDetails?.text ?? "Dots page evaluation failed.",
          );
        }
        return result?.value as T | undefined;
      };
      const evaluate = async <T>(expression: string): Promise<T | undefined> => {
        if (confirmedDot) {
          const currentUrl = await rawEvaluate<string>("window.location.href");
          if (normalizeDotsConversationUrl(currentUrl) !== targetUrl) {
            throw new Error("The Dots tab left the requested conversation. Refusing to continue.");
          }
          tabUrl = currentUrl!;
        }
        return rawEvaluate<T>(expression);
      };
      const assertCurrentDot = async () => {
        const currentUrl = await evaluate<string>("window.location.href");
        if (normalizeDotsConversationUrl(currentUrl) !== targetUrl) {
          throw new Error("The Dots tab left the requested conversation. Refusing to continue.");
        }
        tabUrl = currentUrl!;
        confirmedDot = true;
      };
      const uploadAttachments = async (attachments: Array<{ path: string; name: string }>) => {
        if (attachments.length === 0) return;
        await assertCurrentDot();
        const { root } = await connectedClient.DOM.getDocument();
        const input = await connectedClient.DOM.querySelector({
          nodeId: root.nodeId,
          selector: 'input[data-role="file-input"][type="file"]',
        });
        if (!input.nodeId) throw new Error("Unable to locate the Dots file upload input.");
        await connectedClient.DOM.setFileInputFiles({
          nodeId: input.nodeId,
          files: attachments.map((attachment) => attachment.path),
        });
        const names = attachments.map((attachment) => attachment.name);
        const deadline = Date.now() + (config?.attachmentTimeoutMs ?? 45_000);
        while (Date.now() < deadline) {
          const ready = await evaluate<boolean>(`(() => {
            const scope = document.querySelector('[data-composer-attachments]');
            if (!scope) return false;
            const filenames = Array.from(scope.querySelectorAll('span.truncate'))
              .map((node) => (node.textContent || '').trim());
            const statusScope = scope.cloneNode(true);
            statusScope.querySelectorAll('span.truncate').forEach((node) => node.remove());
            const status = (statusScope.textContent || '').toLowerCase();
            const pending = scope.querySelector('[role="progressbar"], [aria-busy="true"], [data-upload-state="uploading"], [data-state="uploading"], [data-upload-state="processing"], [data-state="processing"], [data-uploading="true"], [class*="animate-spin"]');
            const failed = scope.querySelector('[data-upload-state="error"], [data-state="error"], [data-upload-state="failed"]');
            return !pending && !failed && !/uploading|processing|上传中|正在上传|处理中|正在处理|upload failed|上传失败/.test(status) &&
              ${JSON.stringify(names)}.every((name) => {
                const index = filenames.indexOf(name);
                if (index < 0) return false;
                filenames.splice(index, 1);
                return true;
              });
          })()`);
          if (ready) return;
          await delay(250);
        }
        throw new Error(
          `Timed out waiting for Dots composer attachments to finish uploading: ${names.join(", ")}. Prompt was not submitted.`,
        );
      };
      const runPrompt = async (prompt: string, includeAttachments: boolean) => {
        const completionMarker = `ORACLE-DOTS-DONE-${randomUUID().replaceAll("-", "")}`;
        const wrappedPrompt = `${prompt}\n\nOracle completion protocol:\nComplete all requested work and wait for all tools and their results before giving your final result. At the very end of that final result, output the following completion marker on a separate plain-text line:\n${completionMarker}\nDo not output this marker in progress messages, code blocks, quotes, or examples. If you cannot complete the request, explain the limitation in your final result before outputting the marker. Emit the marker only once, after all work for this request has ended.`;
        const state: Record<string, unknown> = {
          completionMarker,
          inputTimeoutMs: config?.inputTimeoutMs,
          timeoutMs: config?.timeoutMs,
          attachments: includeAttachments
            ? (options.attachments ?? []).map((attachment) => ({
                path: attachment.path,
                name: path.basename(attachment.path),
              }))
            : [],
          insertText: async (text: string) => {
            await assertCurrentDot();
            await connectedClient.Input.insertText({ text });
          },
          onPromptSubmitted: async () => {
            promptSubmitted = true;
            await emitRuntimeHint();
          },
        };
        return runProviderDomFlow(dotsDomProvider, {
          prompt: wrappedPrompt,
          evaluate,
          delay,
          log: logger,
          state,
          beforeSubmit: assertCurrentDot,
          uploadAttachments,
        });
      };
      const initialResult = await runPrompt(options.prompt, true);
      const turns: BrowserConversationTurn[] = [
        {
          label: "Initial response",
          prompt: options.prompt,
          answerText: initialResult.text,
          answerMarkdown: initialResult.text,
        },
      ];
      const followUps = options.followUpPrompts ?? [];
      for (let index = 0; index < followUps.length; index += 1) {
        const followUp = followUps[index];
        logger("[dots-web] Sending follow-up prompt in the same Dot.");
        const result = await runPrompt(followUp, false);
        turns.push({
          label: `Follow-up ${index + 1}`,
          prompt: followUp,
          answerText: result.text,
          answerMarkdown: result.text,
        });
      }
      const { answerText, answerMarkdown } = formatBrowserTurnTranscript(turns);
      await assertCurrentDot();
      await emitRuntimeHint();
      complete = true;
      return {
        ...runtime(),
        answerText,
        answerMarkdown,
        answerHtml: turns.length > 1 ? "" : initialResult.html,
        tookMs: Date.now() - startedAt,
        answerTokens: Math.ceil(answerText.length / 4),
        answerChars: answerText.length,
        modelSelection,
      };
    } finally {
      await client?.close().catch(() => undefined);
      if (
        complete &&
        targetId &&
        (config?.keepBrowser === false || options.closeOwnedTabOnComplete)
      ) {
        await closeTab(port, targetId, logger, host).catch(() => undefined);
      }
      await lease?.release();
    }
  };
}
