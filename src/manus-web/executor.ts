import { closeTab, connectWithNewTab } from "../browser/chromeLifecycle.js";
import { resolveAttachRunningConnection } from "../browser/attachRunning.js";
import { runProviderDomFlow } from "../browser/providerDomFlow.js";
import { manusDomProvider, MANUS_SELECTORS } from "../browser/providers/manusDomProvider.js";
import type { BrowserLogger, BrowserRunOptions, BrowserRunResult } from "../browser/types.js";
import { delay } from "../browser/utils.js";
import path from "node:path";
import { isManusSiteUrl, isRecoverableManusConversationUrl } from "./url.js";

export const MANUS_URL = "https://manus.im/";

function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

function resolveTargetUrl(config: BrowserRunOptions["config"]): string {
  const resumeUrl = config?.resumeConversationUrl?.trim();
  if (resumeUrl) {
    if (!isRecoverableManusConversationUrl(resumeUrl)) {
      throw new Error(
        "Invalid Manus conversation URL. Expected an https://manus.im/app/<conversation-id> link.",
      );
    }
    return resumeUrl;
  }
  const configuredUrl = config?.url ?? config?.chatgptUrl;
  return isManusSiteUrl(configuredUrl) ? configuredUrl! : MANUS_URL;
}

export function createManusWebExecutor(): (
  options: BrowserRunOptions,
) => Promise<BrowserRunResult> {
  return async (options) => {
    const startedAt = Date.now();
    const config = options.config;
    const logger: BrowserLogger = options.log ?? (() => {});
    if (!config?.remoteChrome && !config?.attachRunning) {
      throw new Error(
        "Manus web mode currently requires --remote-chrome or --browser-attach-running with a Chrome profile.",
      );
    }

    const attached = config.attachRunning
      ? await resolveAttachRunningConnection(
          {
            chromePath: config.chromePath ?? null,
            remoteChrome: config.remoteChrome ?? null,
          },
          logger,
        )
      : null;
    const remoteChrome = config.remoteChrome ?? attached;
    if (!remoteChrome) throw new Error("Unable to resolve the attached Chrome endpoint.");
    const { host, port } = remoteChrome;
    const targetUrl = resolveTargetUrl(config);
    logger("[manus-web] Opening an isolated Manus tab in the attached Chrome session.");
    const connection = await connectWithNewTab(port, logger, targetUrl, host, {
      fallbackToDefault: false,
      retries: 2,
      retryDelayMs: 500,
    });
    const { client, targetId } = connection;
    const keepBrowser = config.keepBrowser ?? true;

    try {
      await client.Runtime.enable();
      await client.Page.enable();
      await client.DOM.enable();
      const evaluate = async <T>(expression: string): Promise<T | undefined> => {
        const { result } = await client.Runtime.evaluate({ expression, returnByValue: true });
        if (result?.subtype === "error") {
          throw new Error(result.description ?? "Manus page evaluation failed.");
        }
        return result?.value as T | undefined;
      };
      const responseSelector = JSON.stringify(MANUS_SELECTORS.response.join(", "));
      const responseCount = async (): Promise<number> => {
        const count = await evaluate<number>(`(() => {
          const nodes = Array.from(document.querySelectorAll(${responseSelector}));
          const isAssistant = (node) => [
            node.getAttribute('data-message-role'), node.getAttribute('data-sender'),
            node.getAttribute('data-role'), node.getAttribute('aria-label'),
            typeof node.className === 'string' ? node.className : '',
          ].filter(Boolean).join(' ').toLowerCase().match(/assistant|bot|agent/);
          const assistants = nodes.filter(isAssistant);
          return assistants.length > 0 ? assistants.length : nodes.length;
        })()`);
        return count ?? 0;
      };
      const uploadAttachments = async (attachments: Array<{ path: string; name: string }>) => {
        const attachmentNames = attachments.map((attachment) => attachment.name.toLowerCase());
        // Manus creates the file input only after the plus menu's "Add from local files"
        // action is selected, so open that menu when no input is currently mounted.
        await evaluate<string>(`(() => {
          if (document.querySelector('input[type="file"]')) return 'input';
          const labels = /add from local files|local files|upload files|本地文件|上传文件/i;
          const menuItem = Array.from(document.querySelectorAll('[role="menuitem"], button, [role="button"]'))
            .find((node) => node instanceof HTMLElement && node.offsetParent !== null && labels.test(node.innerText || node.textContent || ''));
          if (menuItem instanceof HTMLElement) {
            menuItem.click();
            return 'menu-clicked';
          }
          const editor = document.querySelector('.chat-input-editor');
          const scope = editor?.closest('form') ?? editor?.parentElement?.parentElement?.parentElement ?? document;
          const plus = Array.from(scope.querySelectorAll('button, [role="button"]')).find((node) => {
            if (!(node instanceof HTMLElement) || node.offsetParent === null || node.hasAttribute('disabled')) return false;
            const marker = ((node.getAttribute('aria-label') || '') + ' ' +
              (node.getAttribute('title') || '') + ' ' + (node.className || '')).toLowerCase();
            return !/send|stop|queue/.test(marker) && !(node.innerText || '').trim();
          });
          if (plus instanceof HTMLElement) {
            plus.click();
            return 'plus-clicked';
          }
          return 'not-found';
        })()`);
        await delay(100);
        const documentNode = await client.DOM.getDocument();
        let result = await client.DOM.querySelector({
          nodeId: documentNode.root.nodeId,
          selector: 'input[type="file"]',
        });
        if (!result.nodeId) {
          await evaluate<string>(`(() => {
            const labels = /add from local files|local files|upload files|本地文件|上传文件/i;
            const menuItem = Array.from(document.querySelectorAll('[role="menuitem"], button, [role="button"]'))
              .find((node) => node instanceof HTMLElement && node.offsetParent !== null && labels.test(node.innerText || node.textContent || ''));
            if (menuItem instanceof HTMLElement) { menuItem.click(); return 'clicked'; }
            return 'not-found';
          })()`);
          await delay(100);
          result = await client.DOM.querySelector({
            nodeId: documentNode.root.nodeId,
            selector: 'input[type="file"]',
          });
        }
        if (!result.nodeId) throw new Error("Unable to locate Manus file upload input.");
        await client.DOM.setFileInputFiles({
          nodeId: result.nodeId,
          files: attachments.map((attachment) => attachment.path),
        });
        const deadline = Date.now() + (config.attachmentTimeoutMs ?? 45_000);
        while (Date.now() < deadline) {
          const ready = await evaluate<boolean>(`(() => {
            const text = (document.body?.innerText || '').toLowerCase();
            const chips = Array.from(document.querySelectorAll('[class*="group/attach"], [class*="attachment"], [data-testid*="file"]'))
              .filter((node) => node instanceof HTMLElement && node.offsetParent !== null)
              .map((node) => (node.textContent || node.getAttribute('aria-label') || '').toLowerCase())
              .join(' ');
            return ${JSON.stringify(attachmentNames)}.every((name) => text.includes(name) || chips.includes(name)) ||
              document.querySelector('input[type="file"]')?.files?.length === ${attachments.length};
          })()`);
          if (ready) return;
          await delay(500);
        }
        throw new Error(`Timed out waiting for Manus attachments: ${attachmentNames.join(", ")}`);
      };
      const runPrompt = async (prompt: string, includeAttachments: boolean) =>
        runProviderDomFlow(manusDomProvider, {
          prompt,
          evaluate,
          delay,
          log: logger,
          state: {
            inputTimeoutMs: config.inputTimeoutMs,
            timeoutMs: config.timeoutMs,
            responseCountBeforeSubmit: await responseCount(),
            attachments: includeAttachments
              ? (options.attachments ?? []).map((attachment) => ({
                  path: attachment.path,
                  name: path.basename(attachment.path),
                }))
              : [],
          },
          uploadAttachments,
        });

      let result = await runPrompt(options.prompt, true);
      for (const followUp of options.followUpPrompts ?? []) {
        logger("[manus-web] Sending follow-up prompt in the same conversation.");
        result = await runPrompt(followUp, false);
      }
      const tabUrl = (await evaluate<string>("window.location.href")) ?? targetUrl;
      const tookMs = Date.now() - startedAt;
      return {
        answerText: result.text,
        answerMarkdown: result.text,
        answerHtml: result.html,
        tookMs,
        answerTokens: estimateTokenCount(result.text),
        answerChars: result.text.length,
        browserTransport: "cdp",
        chromeHost: host,
        chromePort: port,
        chromeBrowserWSEndpoint: attached?.browserWSEndpoint,
        chromeProfileRoot: attached?.profileRoot,
        chromeTargetId: targetId,
        tabUrl,
        promptSubmitted: true,
        controllerPid: process.pid,
      };
    } finally {
      await client.close().catch(() => undefined);
      if (!keepBrowser && targetId) {
        await closeTab(port, targetId, logger, host).catch(() => undefined);
      }
    }
  };
}
