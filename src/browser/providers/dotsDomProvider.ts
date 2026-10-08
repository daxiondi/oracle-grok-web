import type {
  ProviderDomAdapter,
  ProviderDomFlowContext,
  ProviderDomResponse,
} from "../providerDomFlow.js";

const UI_TIMEOUT_MS = 60_000;
const RESPONSE_TIMEOUT_MS = 20 * 60_000;
const POLL_INTERVAL_MS = 500;
const RESPONSE_STABLE_MS = 3_000;

export interface DotsDomProviderState {
  inputTimeoutMs?: number;
  timeoutMs?: number;
  attachments?: Array<{ path: string; name: string }>;
  insertText?: (text: string) => Promise<void>;
  onPromptSubmitted?: () => Promise<void>;
  baselineMessageIds?: string[];
  userMessageId?: string;
  completionMarker?: string;
}

export const DOTS_SELECTORS = {
  input: '[data-composer-body] [contenteditable="true"][role="textbox"]',
  sendButton:
    '[data-composer-body] button[aria-label="发送"], [data-composer-body] button[aria-label="Send" i]',
  message: "article.message-row[data-message-id]",
  messageText: ".message-text",
  typing: '.typing-indicator, [data-testid="typing-indicator"]',
} as const;

interface DotsMessage {
  id: string;
  self: boolean;
  pending: boolean;
  plainText: string;
  text: string;
  html: string;
  completionMarkerFound: boolean;
  textWithoutCompletionMarker: string;
  htmlWithoutCompletionMarker: string;
}

interface DotsSnapshot {
  ready: boolean;
  draft: string;
  sendEnabled: boolean;
  typing: boolean | null;
  error: string | null;
  messages: DotsMessage[];
}

function freshMessageTail(
  messages: DotsMessage[],
  baseline: ReadonlySet<string>,
): { startIndex: number; messages: DotsMessage[] } {
  // Unknown IDs above the latest known row can be older history hydrating.
  let boundaryIndex = messages.length - 1;
  while (boundaryIndex >= 0 && !baseline.has(messages[boundaryIndex].id)) boundaryIndex -= 1;
  if (baseline.size > 0 && boundaryIndex < 0) {
    throw new Error(
      "The Dots message baseline is no longer visible; the response cannot be attributed safely. " +
        JSON.stringify({ baselineCount: baseline.size, messageCount: messages.length }),
    );
  }
  return { startIndex: boundaryIndex + 1, messages: messages.slice(boundaryIndex + 1) };
}

function stateFor(ctx: ProviderDomFlowContext): DotsDomProviderState {
  ctx.state ??= {};
  return ctx.state as DotsDomProviderState;
}

function timeoutFor(ctx: ProviderDomFlowContext, kind: "ui" | "response"): number {
  const state = stateFor(ctx);
  const value = kind === "ui" ? state.inputTimeoutMs : state.timeoutMs;
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(1_000, value)
    : kind === "ui"
      ? UI_TIMEOUT_MS
      : RESPONSE_TIMEOUT_MS;
}

function normalizeText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .trim();
}

function containsMarkerLine(text: string, marker: string): boolean {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .some((line) => line.trim() === marker);
}

function hasRequestMarker(message: DotsMessage, marker: string): boolean {
  return containsMarkerLine(message.plainText, marker) || containsMarkerLine(message.text, marker);
}

// ProseMirror represents one input newline as a paragraph boundary. innerText
// adds visual spacing between paragraphs, while textContent removes that boundary.
// Reuse the same logical reader for draft verification, submission, and anchoring.
const logicalTextReaderExpression = `((root) => {
  const blockTags = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'PRE', 'BLOCKQUOTE', 'UL', 'OL']);
  const read = (node) => {
    if (node.nodeType === 3) return node.textContent || '';
    const tag = node.tagName?.toUpperCase();
    if (tag === 'BR') return node.classList.contains('ProseMirror-trailingBreak') ? '' : '\\n';
    const children = Array.from(node.childNodes || []);
    if ((tag === 'P' || tag === 'DIV') && children.length === 1 && children[0].tagName === 'BR') return '';
    let value = '';
    let previousBlock = false;
    for (let index = 0; index < children.length; index += 1) {
      const child = children[index];
      const block = blockTags.has(child.tagName?.toUpperCase());
      if (index > 0 && (block || previousBlock)) value += '\\n';
      value += read(child);
      previousBlock = block;
    }
    return value;
  };
  return root ? read(root) : '';
})`;

// Keep the script self-contained: it runs in the attached tab, without Node helpers.
const snapshotExpression = `(() => {
  const readLogicalText = ${logicalTextReaderExpression};
  const editor = document.querySelector(${JSON.stringify(DOTS_SELECTORS.input)});
  const button = document.querySelector(${JSON.stringify(DOTS_SELECTORS.sendButton)});
  const indicator = document.querySelector(${JSON.stringify(DOTS_SELECTORS.typing)});
  const typingValue = indicator?.getAttribute('data-visible');
  const alert = document.querySelector('[role="alert"], [data-testid="error-message"], .error-message');
  const alertText = (alert?.innerText || alert?.textContent || '').trim();
  const body = (document.body?.innerText || '').toLowerCase();
  const visible = Boolean(editor && editor.getClientRects().length > 0);
  const loginRequired = !visible && (
    body.includes('sign in to continue') || body.includes('log in to continue') ||
    body.includes('登录以继续') || body.includes('登入以繼續') ||
    Boolean(document.querySelector('a[href*="/auth/login"], button[data-testid="login-button"]'))
  );
  const challenged = !visible && (body.includes('verify you are human') || body.includes('checking your browser'));
  const renderChildren = (node) => Array.from(node.childNodes || []).map(render).join('');
  const render = (node) => {
    if (node.nodeType === 3) return node.textContent || '';
    const tag = node.tagName?.toUpperCase();
    if (tag === 'PRE') {
      const code = node.querySelector('code') || node;
      const value = code.textContent || '';
      const language = (code.getAttribute('class') || '').match(/(?:^|\\s)language-([\\w+-]+)/)?.[1] || '';
      const runs = value.match(/\x60+/g) || [];
      const fence = '\x60'.repeat(Math.max(3, ...runs.map((run) => run.length + 1)));
      return '\\n\\n' + fence + language + '\\n' + value.replace(/\\n$/, '') + '\\n' + fence + '\\n\\n';
    }
    if (tag === 'CODE') {
      const value = node.textContent || '';
      const fence = value.includes('\x60') ? '\x60\x60' : '\x60';
      return fence + value + fence;
    }
    if (tag === 'BR') return '\\n';
    if (tag === 'HR') return '\\n\\n---\\n\\n';
    if (tag === 'IMG') return '![' + (node.getAttribute('alt') || '') + '](' + (node.getAttribute('src') || '') + ')';
    if (tag === 'TABLE') {
      const rows = [];
      const collectRows = (parent, inHead = false) => {
        for (const child of Array.from(parent.children || [])) {
          if (child.tagName === 'TR') {
            const cells = Array.from(child.children || []).filter((cell) => cell.tagName === 'TH' || cell.tagName === 'TD');
            if (cells.length) rows.push({ cells, inHead });
          } else if (child.tagName !== 'TABLE') {
            collectRows(child, inHead || child.tagName === 'THEAD');
          }
        }
      };
      collectRows(node);
      const caption = Array.from(node.children || []).find((child) => child.tagName === 'CAPTION');
      const title = caption ? renderChildren(caption).trim() + '\\n\\n' : '';
      if (!rows.length) return title;
      const cellText = (cell) => renderChildren(cell).trim().replace(/\\r\\n?/g, '\\n').replace(/\\n+/g, '<br>').replace(/\\|/g, '\\\\|');
      const values = rows.map(({ cells }) => cells.map(cellText));
      const width = Math.max(...values.map((cells) => cells.length));
      const hasHeader = rows[0].inHead || rows[0].cells.every((cell) => cell.tagName === 'TH');
      const header = hasHeader ? values.shift() : [];
      const line = (cells) => '| ' + Array.from({ length: width }, (_, index) => cells[index] || '').join(' | ') + ' |';
      return '\\n\\n' + title + [line(header), line(Array(width).fill('---')), ...values.map(line)].join('\\n') + '\\n\\n';
    }
    const content = renderChildren(node);
    if (/^H[1-6]$/.test(tag || '')) return '\\n\\n' + '#'.repeat(Number(tag.slice(1))) + ' ' + content.trim() + '\\n\\n';
    if (tag === 'STRONG' || tag === 'B') return '**' + content + '**';
    if (tag === 'EM' || tag === 'I') return '*' + content + '*';
    if (tag === 'DEL' || tag === 'S') return '~~' + content + '~~';
    if (tag === 'A') {
      const href = node.getAttribute('href');
      return href ? '[' + content + '](' + href + ')' : content;
    }
    if (tag === 'UL' || tag === 'OL') {
      const start = Number(node.getAttribute('start') || '1');
      const items = Array.from(node.children || []).filter((child) => child.tagName === 'LI');
      return '\\n\\n' + items.map((item, index) => {
        const prefix = tag === 'OL' ? String(start + index) + '. ' : '- ';
        return prefix + renderChildren(item).trim().replace(/\\n/g, '\\n' + ' '.repeat(prefix.length));
      }).join('\\n') + '\\n\\n';
    }
    if (tag === 'BLOCKQUOTE') return '\\n\\n' + content.trim().split('\\n').map((line) => '> ' + line).join('\\n') + '\\n\\n';
    if (tag === 'P' || tag === 'DIV') return content ? '\\n\\n' + content.trim() + '\\n\\n' : '';
    return content;
  };
  const completionFooter = (content, text) => {
    const unchanged = { completionMarkerFound: false, textWithoutCompletionMarker: text, htmlWithoutCompletionMarker: content?.innerHTML || '' };
    if (!content || !completionMarker || text.split('\\n').at(-1)?.trim() !== completionMarker || readLogicalText(content).trim().split('\\n').at(-1)?.trim() !== completionMarker) return unchanged;
    let fence;
    for (const line of text.split('\\n')) {
      const marker = line.match(/^\\s{0,3}(\x60{3,}|~{3,})(.*)$/);
      if (fence) {
        if (marker && marker[1][0] === fence.character && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
      } else if (marker) {
        fence = { character: marker[1][0], length: marker[1].length };
      }
    }
    if (fence) return unchanged;
    const clone = content.cloneNode(true);
    const leaves = [];
    const collect = (node, blocked = false) => {
      if (node.nodeType === 3) {
        leaves.push({ node, blocked });
        return;
      }
      const plainWrapper = ['DIV', 'P', 'SPAN', 'BR'].includes(node.tagName?.toUpperCase());
      for (const child of Array.from(node.childNodes || [])) collect(child, blocked || !plainWrapper);
    };
    collect(clone);
    let remaining = completionMarker.length;
    let trailingWhitespace = true;
    for (let index = leaves.length - 1; index >= 0 && remaining > 0; index -= 1) {
      const { node, blocked } = leaves[index];
      let value = node.textContent || '';
      if (trailingWhitespace) value = value.replace(/\\s+$/, '');
      if (!value) {
        node.textContent = '';
        continue;
      }
      trailingWhitespace = false;
      const length = Math.min(value.length, remaining);
      if (blocked || value.slice(-length) !== completionMarker.slice(remaining - length, remaining)) return unchanged;
      node.textContent = value.slice(0, value.length - length);
      remaining -= length;
      if (!remaining) node.textContent = node.textContent.replace(/\\r?\\n[ \\t]*$/, '');
    }
    if (remaining) return unchanged;
    return { completionMarkerFound: true, textWithoutCompletionMarker: renderChildren(clone).trim(), htmlWithoutCompletionMarker: clone.innerHTML };
  };
  const messages = Array.from(document.querySelectorAll(${JSON.stringify(DOTS_SELECTORS.message)})).map((row) => {
    const content = row.querySelector(${JSON.stringify(DOTS_SELECTORS.messageText)});
    const text = content ? renderChildren(content).trim() : '';
    return {
      id: row.getAttribute('data-message-id') || '',
      self: row.classList.contains('self'),
      pending: row.classList.contains('pending'),
      plainText: readLogicalText(content),
      text,
      html: content?.innerHTML || '',
      ...completionFooter(content, text),
    };
  });
  return {
    ready: visible && editor.getAttribute('contenteditable') === 'true',
    draft: readLogicalText(editor),
    sendEnabled: Boolean(button && !button.disabled && button.getAttribute('aria-disabled') !== 'true'),
    typing: typingValue === 'true' ? true : typingValue === 'false' ? false : null,
    error: loginRequired ? 'Dots requires sign-in in the attached GeekEZ profile.' :
      challenged ? 'Dots is showing a browser verification challenge.' : alertText || null,
    messages,
  };
})()`;

async function snapshot(ctx: ProviderDomFlowContext): Promise<DotsSnapshot> {
  const result = await ctx.evaluate<DotsSnapshot>(`(() => {
    const completionMarker = ${JSON.stringify(stateFor(ctx).completionMarker ?? "")};
    return ${snapshotExpression};
  })()`);
  if (!result || !Array.isArray(result.messages)) {
    throw new Error("Unable to read the Dots conversation DOM.");
  }
  if (result.error) throw new Error(result.error);
  return result;
}

async function waitForUi(ctx: ProviderDomFlowContext): Promise<void> {
  ctx.log?.("[dots-web] Waiting for the Dots composer...");
  const deadline = Date.now() + timeoutFor(ctx, "ui");
  while (Date.now() < deadline) {
    const current = await snapshot(ctx);
    if (current.ready) {
      if (normalizeText(current.draft)) {
        throw new Error("Dots has an existing draft. It was preserved; use an empty composer.");
      }
      if (
        current.typing === true ||
        current.messages.some((message) => message.self && message.pending)
      ) {
        throw new Error("Dots is already processing another message. Wait for it to finish.");
      }
      return;
    }
    await ctx.delay(POLL_INTERVAL_MS);
  }
  throw new Error("Timed out waiting for the Dots prompt input.");
}

async function typePrompt(ctx: ProviderDomFlowContext): Promise<void> {
  const state = stateFor(ctx);
  if (!state.insertText) {
    throw new Error("Dots requires trusted browser text input in this session.");
  }
  if (!state.completionMarker || /\s/.test(state.completionMarker)) {
    throw new Error("Dots requires a unique completion marker before a prompt can be sent.");
  }
  if (!containsMarkerLine(ctx.prompt, state.completionMarker)) {
    throw new Error(
      "The Dots prompt must include this turn's request marker on its own line. Nothing was sent.",
    );
  }
  if (!normalizeText(ctx.prompt)) throw new Error("The Dots prompt is empty.");
  const beforeUpload = await snapshot(ctx);
  if (normalizeText(beforeUpload.draft)) {
    throw new Error("Dots has an existing draft. It was preserved; use an empty composer.");
  }
  const attachments = state.attachments ?? [];
  if (attachments.length) {
    if (!ctx.uploadAttachments) {
      throw new Error("Dots attachment upload is unavailable in this browser session.");
    }
    await ctx.uploadAttachments(attachments);
  }
  const beforeTyping = await snapshot(ctx);
  if (!beforeTyping.ready || normalizeText(beforeTyping.draft)) {
    throw new Error("The Dots composer changed before typing. Its contents were preserved.");
  }
  if (
    beforeTyping.typing === true ||
    beforeTyping.messages.some((message) => message.self && message.pending)
  ) {
    throw new Error("Dots is already processing another message. Wait for it to finish.");
  }
  state.baselineMessageIds = beforeTyping.messages.map((message) => message.id);
  delete state.userMessageId;
  const focused = await ctx.evaluate<boolean>(`(() => {
    const readLogicalText = ${logicalTextReaderExpression};
    const editor = document.querySelector(${JSON.stringify(DOTS_SELECTORS.input)});
    if (!editor || readLogicalText(editor).trim()) return false;
    editor.focus();
    return document.activeElement === editor;
  })()`);
  if (!focused) throw new Error("Unable to focus the empty Dots composer.");
  await state.insertText(ctx.prompt);
  const deadline = Date.now() + timeoutFor(ctx, "ui");
  while (Date.now() < deadline) {
    const current = await snapshot(ctx);
    if (normalizeText(current.draft) !== normalizeText(ctx.prompt)) {
      throw new Error("The Dots composer does not contain the complete prompt. Nothing was sent.");
    }
    if (current.ready && current.sendEnabled) return;
    await ctx.delay(POLL_INTERVAL_MS);
  }
  throw new Error("Timed out waiting for the Dots send button to become available.");
}

async function submitPrompt(ctx: ProviderDomFlowContext): Promise<void> {
  const state = stateFor(ctx);
  const marker = state.completionMarker;
  if (!marker || !containsMarkerLine(ctx.prompt, marker)) {
    throw new Error("The Dots prompt is missing this turn's request marker. Nothing was sent.");
  }
  const baseline = new Set(state.baselineMessageIds ?? []);
  if (!state.baselineMessageIds)
    throw new Error("Dots submission is missing its message baseline.");
  const beforeSend = await snapshot(ctx);
  if (freshMessageTail(beforeSend.messages, baseline).messages.some((message) => message.self)) {
    throw new Error("Another user message appeared in Dots before submission. Nothing was sent.");
  }
  const sent = await ctx.evaluate<string>(`(() => {
    const readLogicalText = ${logicalTextReaderExpression};
    const editor = document.querySelector(${JSON.stringify(DOTS_SELECTORS.input)});
    const normalize = (text) => text.replace(/\\r\\n?/g, '\\n').replace(/\\u00a0/g, ' ').trim();
    if (!editor || normalize(readLogicalText(editor)) !== ${JSON.stringify(normalizeText(ctx.prompt))}) return 'draft-changed';
    const button = document.querySelector(${JSON.stringify(DOTS_SELECTORS.sendButton)});
    if (!button || button.disabled || button.getAttribute('aria-disabled') === 'true') return 'unavailable';
    button.click();
    return 'clicked';
  })()`);
  if (sent !== "clicked")
    throw new Error(`Failed to submit the Dots prompt (${sent ?? "unknown"}).`);
  await state.onPromptSubmitted?.();
  ctx.log?.("[dots-web] Waiting for the submitted message to be saved...");
  const deadline = Date.now() + timeoutFor(ctx, "ui");
  let lastSnapshot: DotsSnapshot | undefined;
  while (Date.now() < deadline) {
    const current = await snapshot(ctx);
    lastSnapshot = current;
    const users = freshMessageTail(current.messages, baseline).messages.filter(
      (message) => message.self,
    );
    if (users.length > 1) {
      throw new Error(
        "Another user message appeared in Dots during submission; the response cannot be attributed safely.",
      );
    }
    const anchor = users.find((message) => !message.pending && message.id);
    // The saved user bubble renders Markdown, so its visible text cannot equal
    // every literal source prompt. The exact source was verified before clicking.
    // A cleared composer and a unique fresh saved row containing the high-entropy
    // per-turn request marker confirm identity across Markdown transformations.
    if (anchor && !normalizeText(current.draft) && hasRequestMarker(anchor, marker)) {
      state.userMessageId = anchor.id;
      return;
    }
    await ctx.delay(POLL_INTERVAL_MS);
  }
  throw new Error(
    "Timed out confirming the submitted Dots user message. It may have been sent; do not retry automatically. " +
      JSON.stringify({
        anchorFound: false,
        anchorId: state.userMessageId ?? null,
        typing: lastSnapshot?.typing ?? null,
        messageCount: lastSnapshot?.messages.length ?? 0,
        pendingUserCount:
          lastSnapshot?.messages.filter((message) => message.self && message.pending).length ?? 0,
      }),
  );
}

async function waitForResponse(ctx: ProviderDomFlowContext): Promise<ProviderDomResponse> {
  const state = stateFor(ctx);
  if (!state.userMessageId || !state.baselineMessageIds) {
    throw new Error("Dots response capture requires a confirmed submitted user message.");
  }
  if (!state.completionMarker || /\s/.test(state.completionMarker)) {
    throw new Error("Dots response capture requires this turn's completion marker.");
  }
  const baseline = new Set(state.baselineMessageIds);
  const deadline = Date.now() + timeoutFor(ctx, "response");
  let previousSignature = "";
  let stableSince: number | undefined;
  let lastDiagnostics = {
    anchorFound: false,
    anchorId: state.userMessageId,
    typing: null as boolean | null,
    messageCount: 0,
    responseCount: 0,
    stableForMs: 0,
    anchorChanges: 0,
    completionMarkerSeen: false,
    latestAssistantId: null as string | null,
  };
  ctx.log?.("[dots-web] Waiting for the Dots response...");
  while (Date.now() < deadline) {
    const current = await snapshot(ctx);
    const fresh = freshMessageTail(current.messages, baseline);
    const newUsers = fresh.messages.filter((message) => message.self);
    if (newUsers.length > 1) {
      throw new Error(
        "Another user message appeared after this Dots prompt; the response cannot be attributed safely.",
      );
    }
    let anchorIndex = current.messages.findIndex(
      (message) => message.id === state.userMessageId && message.self && !message.pending,
    );
    if (anchorIndex >= 0 && anchorIndex < fresh.startIndex) {
      throw new Error(
        "The Dots message order changed across the submission baseline; the response cannot be attributed safely.",
      );
    }
    // Dots can replace an optimistic UUID after removing the pending class. Only
    // the unique fresh user row carrying this turn's request marker may replace it.
    const replacement = newUsers[0];
    if (anchorIndex < 0 && replacement && !replacement.pending && replacement.id) {
      if (!hasRequestMarker(replacement, state.completionMarker)) {
        throw new Error(
          "The Dots submitted message disappeared and its replacement could not be confirmed; the response cannot be attributed safely.",
        );
      }
      state.userMessageId = replacement.id;
      anchorIndex = current.messages.indexOf(replacement);
      lastDiagnostics.anchorChanges += 1;
      previousSignature = "";
      stableSince = undefined;
      ctx.log?.("[dots-web] Reacquired the submitted message after its ID changed.");
    }
    lastDiagnostics = {
      ...lastDiagnostics,
      anchorFound: anchorIndex >= 0,
      anchorId: state.userMessageId,
      typing: current.typing,
      messageCount: current.messages.length,
      responseCount: 0,
      stableForMs: 0,
      completionMarkerSeen: false,
      latestAssistantId: null,
    };
    if (anchorIndex >= 0) {
      const following = current.messages.slice(anchorIndex + 1);
      if (following.some((message) => message.self)) {
        throw new Error(
          "Another user message appeared after this Dots prompt; the response cannot be attributed safely.",
        );
      }
      const assistantMessages = following.filter(
        (message) => !message.self && !baseline.has(message.id),
      );
      const responses = assistantMessages.filter(
        (message) =>
          !message.self && !message.pending && !baseline.has(message.id) && message.text.trim(),
      );
      const latest = assistantMessages[assistantMessages.length - 1];
      const output = responses.filter((message) => message.textWithoutCompletionMarker.trim());
      lastDiagnostics.responseCount = responses.length;
      lastDiagnostics.completionMarkerSeen =
        latest?.completionMarkerFound === true && !latest.pending;
      lastDiagnostics.latestAssistantId = latest?.id ?? null;
      if (output.length && lastDiagnostics.completionMarkerSeen && current.typing !== true) {
        // Rendering attributes can keep changing after the answer is complete.
        // Stabilize on message identity and Markdown content, returning fresh HTML.
        const signature = JSON.stringify(responses.map(({ id, text }) => ({ id, text })));
        if (signature !== previousSignature) {
          previousSignature = signature;
          stableSince = Date.now();
        }
        lastDiagnostics.stableForMs = stableSince === undefined ? 0 : Date.now() - stableSince;
        if (lastDiagnostics.stableForMs >= RESPONSE_STABLE_MS) {
          return {
            text: output.map((message) => message.textWithoutCompletionMarker).join("\n\n"),
            html: output.map((message) => message.htmlWithoutCompletionMarker).join("\n"),
            meta: { messageId: responses[responses.length - 1].id },
          };
        }
      } else {
        previousSignature = "";
        stableSince = undefined;
      }
    } else {
      previousSignature = "";
      stableSince = undefined;
    }
    await ctx.delay(POLL_INTERVAL_MS);
  }
  throw new Error(
    "Timed out waiting for Dots to finish responding with this turn's explicit completion marker. " +
      JSON.stringify(lastDiagnostics),
  );
}

export const dotsDomProvider: ProviderDomAdapter = {
  providerName: "dots-web",
  waitForUi,
  typePrompt,
  submitPrompt,
  waitForResponse,
};
