import type { ProviderDomAdapter, ProviderDomFlowContext } from "../providerDomFlow.js";
import { joinSelectors } from "../providerDomFlow.js";

const UI_TIMEOUT_MS = 60_000;
const RESPONSE_TIMEOUT_MS = 20 * 60_000;

interface ManusDomProviderState {
  inputTimeoutMs?: number;
  timeoutMs?: number;
  responseCountBeforeSubmit?: number;
  attachments?: Array<{ path: string; name: string }>;
}

/**
 * Manus uses a Tiptap editor. The class names below are more stable than the
 * generated React class names, while the generic fallbacks keep this adapter
 * usable when Manus changes the surrounding composer markup.
 */
export const MANUS_SELECTORS = {
  input: [
    '.chat-input-editor .ProseMirror[contenteditable="true"]',
    '.chat-input-editor [contenteditable="true"]',
    '[data-testid="chat-input"] [contenteditable="true"]',
    '[contenteditable="true"][role="textbox"]',
    'textarea[placeholder*="message" i]',
    'textarea[placeholder*="ask" i]',
  ],
  sendButton: [
    '[class*="send-button"] button:not([disabled])',
    'button[aria-label*="send" i]:not([disabled])',
    'button[title*="send" i]:not([disabled])',
    'button[data-testid*="send" i]:not([disabled])',
    'button[type="submit"]:not([disabled])',
  ],
  stopButton: [
    'button[aria-label*="stop" i]',
    'button[title*="stop" i]',
    'button[data-testid*="stop" i]',
    '[class*="stop-button"]',
  ],
  response: [
    '[data-message-role="assistant"]',
    '[data-sender="assistant"]',
    '[data-role="assistant"]',
    '[data-testid*="assistant"]',
    '[class*="assistant-message"]',
    '[class*="message"][class*="assistant"]',
    "[data-message-id]",
    '[class*="chat-message"]',
    '[class*="message"]',
  ],
  responseContent: [
    "[data-message-content]",
    "[data-content]",
    ".markdown-content",
    ".markdown",
    ".prose",
    '[class*="message-content"]',
    '[class*="content"]',
  ],
} as const;

function selectorLiteral(selectors: readonly string[]): string {
  return JSON.stringify(joinSelectors(selectors));
}

function readTimeouts(ctx: ProviderDomFlowContext): { ui: number; response: number } {
  const state = ctx.state as ManusDomProviderState | undefined;
  return {
    ui:
      typeof state?.inputTimeoutMs === "number"
        ? Math.max(1_000, state.inputTimeoutMs)
        : UI_TIMEOUT_MS,
    response:
      typeof state?.timeoutMs === "number" ? Math.max(1_000, state.timeoutMs) : RESPONSE_TIMEOUT_MS,
  };
}

async function waitForUi(ctx: ProviderDomFlowContext): Promise<void> {
  ctx.log?.("[manus-web] Waiting for Manus UI to load...");
  const input = selectorLiteral(MANUS_SELECTORS.input);
  const deadline = Date.now() + readTimeouts(ctx).ui;
  while (Date.now() < deadline) {
    const state = await ctx.evaluate<{
      ready?: boolean;
      blocked?: boolean;
      loginRequired?: boolean;
    }>(
      `(() => {
        const editor = document.querySelector(${input});
        const visible = editor instanceof HTMLElement && editor.offsetParent !== null;
        const body = (document.body?.innerText || '').toLowerCase();
        const loginRequired = body.includes('sign in to continue') ||
          body.includes('log in to continue') ||
          (body.includes('sign in') && body.includes('sign up')) ||
          Boolean(document.querySelector('[data-testid*="login" i], [data-testid*="sign-in" i]'));
        return {
          ready: visible,
          blocked: body.includes('verify you are human') || body.includes('checking your browser'),
          loginRequired,
        };
      })()`,
    );
    if (state?.loginRequired) {
      throw new Error(
        "Manus requires sign-in before it will answer. Sign in at manus.im in the attached Chrome profile and retry.",
      );
    }
    if (state?.ready) return;
    if (state?.blocked) {
      throw new Error(
        "Manus is showing a browser verification challenge. Complete it in Chrome and retry.",
      );
    }
    await ctx.delay(1_000);
  }
  throw new Error("Timed out waiting for the Manus prompt input.");
}

async function typePrompt(ctx: ProviderDomFlowContext): Promise<void> {
  const attachments = (ctx.state as ManusDomProviderState | undefined)?.attachments ?? [];
  if (attachments.length > 0) {
    if (!ctx.uploadAttachments) {
      throw new Error("Manus attachment upload is unavailable in this browser session.");
    }
    ctx.log?.(`[manus-web] Uploading ${attachments.length} attachment(s)...`);
    await ctx.uploadAttachments(attachments);
  }

  ctx.log?.("[manus-web] Typing prompt...");
  const input = selectorLiteral(MANUS_SELECTORS.input);
  const result = await ctx.evaluate<string>(
    `(() => {
      const editor = document.querySelector(${input});
      if (!(editor instanceof HTMLElement)) return 'not-found';
      editor.focus();
      const value = ${JSON.stringify(ctx.prompt)};
      if (editor instanceof HTMLTextAreaElement) {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
        setter?.call(editor, value);
        editor.dispatchEvent(new Event('input', { bubbles: true }));
        editor.dispatchEvent(new Event('change', { bubbles: true }));
        return editor.value === value ? 'typed' : 'mismatch';
      }
      editor.textContent = '';
      const inserted = typeof document.execCommand === 'function' &&
        document.execCommand('insertText', false, value);
      if (!inserted) {
        editor.textContent = value;
        editor.dispatchEvent(new InputEvent('beforeinput', {
          bubbles: true,
          inputType: 'insertText',
          data: value,
        }));
        editor.dispatchEvent(new InputEvent('input', {
          bubbles: true,
          inputType: 'insertText',
          data: value,
        }));
      }
      return (editor.innerText || editor.textContent || '').trim() === value ? 'typed' : 'mismatch';
    })()`,
  );
  if (result !== "typed") {
    throw new Error(`Failed to type the Manus prompt (${result ?? "unknown"}).`);
  }
  await ctx.delay(300);
}

async function submitPrompt(ctx: ProviderDomFlowContext): Promise<void> {
  ctx.log?.("[manus-web] Sending prompt...");
  const send = selectorLiteral(MANUS_SELECTORS.sendButton);
  const input = selectorLiteral(MANUS_SELECTORS.input);
  const result = await ctx.evaluate<string>(
    `(() => {
      const button = Array.from(document.querySelectorAll(${send})).find(
        (node) => node instanceof HTMLElement && node.offsetParent !== null && !node.hasAttribute('disabled'),
      );
      if (button instanceof HTMLElement) {
        button.click();
        return 'clicked';
      }
      const editor = document.querySelector(${input});
      if (editor instanceof HTMLElement) {
        editor.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Enter', code: 'Enter', bubbles: true, cancelable: true,
        }));
        return 'enter';
      }
      return 'not-found';
    })()`,
  );
  if (result !== "clicked" && result !== "enter") {
    throw new Error(`Failed to submit the Manus prompt (${result ?? "unknown"}).`);
  }
}

async function waitForResponse(
  ctx: ProviderDomFlowContext,
): Promise<{ text: string; html?: string }> {
  ctx.log?.("[manus-web] Waiting for Manus response...");
  const response = selectorLiteral(MANUS_SELECTORS.response);
  const responseContent = selectorLiteral(MANUS_SELECTORS.responseContent);
  const stop = selectorLiteral(MANUS_SELECTORS.stopButton);
  const state = ctx.state as ManusDomProviderState | undefined;
  const initialCount = state?.responseCountBeforeSubmit ?? 0;
  const deadline = Date.now() + readTimeouts(ctx).response;
  let previousText = "";
  let stablePolls = 0;

  while (Date.now() < deadline) {
    const raw = await ctx.evaluate<string>(
      `(() => {
        const all = Array.from(document.querySelectorAll(${response}));
        const marker = (node) => [
          node.getAttribute('data-message-role'), node.getAttribute('data-sender'),
          node.getAttribute('data-role'), node.getAttribute('aria-label'),
          typeof node.className === 'string' ? node.className : '',
        ].filter(Boolean).join(' ').toLowerCase();
        const assistants = all.filter((node) => /assistant|bot|agent/.test(marker(node)));
        const turns = assistants.length > 0 ? assistants : all;
        const body = (document.body?.innerText || '').toLowerCase();
        const loginDialog = Array.from(document.querySelectorAll('[role="dialog"], [class*="modal"]'))
          .some((node) => /sign in|log in|continue with google|登录/.test((node.innerText || '').toLowerCase()));
        if (loginDialog || body.includes('sign in to continue') || body.includes('log in to continue')) {
          return JSON.stringify({ status: 'login-required' });
        }
        if (turns.length <= ${initialCount}) return JSON.stringify({ status: 'waiting' });
        const last = turns[turns.length - 1];
        const content = last.querySelector(${responseContent}) ?? last;
        const text = (content?.innerText || content?.textContent || '').trim();
        const prompt = ${JSON.stringify(ctx.prompt)}.trim();
        if (!text || text === prompt || text.includes(prompt + '\\n')) {
          return JSON.stringify({ status: 'waiting', text: '' });
        }
        const stopVisible = Array.from(document.querySelectorAll(${stop})).some(
          (node) => node instanceof HTMLElement && node.offsetParent !== null,
        );
        const streaming = stopVisible || last.getAttribute('aria-busy') === 'true' ||
          /streaming|loading|generating/.test(marker(last));
        return JSON.stringify({
          status: streaming ? 'streaming' : 'idle',
          text,
          html: content?.innerHTML || '',
        });
      })()`,
    );
    const payload = JSON.parse(raw ?? "{}") as { status?: string; text?: string; html?: string };
    if (payload.status === "login-required") {
      throw new Error(
        "Manus requires sign-in before it will answer. Sign in at manus.im in the attached Chrome profile and retry.",
      );
    }
    const currentText = payload.text?.trim() ?? "";
    if (currentText && currentText === previousText && payload.status === "idle") {
      stablePolls += 1;
      if (stablePolls >= 2) return { text: currentText, html: payload.html };
    } else {
      stablePolls = 0;
      previousText = currentText;
    }
    await ctx.delay(1_000);
  }
  throw new Error("Timed out waiting for Manus to finish responding.");
}

export const manusDomProvider: ProviderDomAdapter = {
  providerName: "manus-web",
  waitForUi,
  typePrompt,
  submitPrompt,
  waitForResponse,
};
