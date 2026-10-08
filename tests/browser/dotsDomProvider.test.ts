import vm from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  runProviderDomFlow,
  type ProviderDomFlowContext,
} from "../../src/browser/providerDomFlow.js";
import {
  dotsDomProvider,
  DOTS_SELECTORS,
  type DotsDomProviderState,
} from "../../src/browser/providers/dotsDomProvider.js";

const TEST_COMPLETION_MARKER = "ORACLE-DOTS-DONE-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function requestPrompt(text: string, marker = TEST_COMPLETION_MARKER): string {
  return `${text}\n\nOracle request marker:\n${marker}\nEmit this marker only after completing the request.`;
}

class TextNode {
  readonly nodeType = 3;
  constructor(public textContent: string) {}
}

class ElementNode {
  readonly nodeType = 1;
  childNodes: Array<ElementNode | TextNode>;
  disabled = false;
  visible = true;
  innerTextOverride?: string;
  onFocus?: () => void;
  onClick?: () => void;
  onAfterClick?: () => void;

  constructor(
    public tagName: string,
    public attributes: Record<string, string> = {},
    children: Array<ElementNode | TextNode | string> = [],
  ) {
    this.childNodes = children.map((child) =>
      typeof child === "string" ? new TextNode(child) : child,
    );
  }

  get children(): ElementNode[] {
    return this.childNodes.filter((node): node is ElementNode => node instanceof ElementNode);
  }

  get textContent(): string {
    return this.childNodes.map((child) => child.textContent).join("");
  }

  set textContent(value: string) {
    this.childNodes = [new TextNode(value)];
  }

  get innerText(): string {
    return this.innerTextOverride ?? this.textContent;
  }

  get innerHTML(): string {
    return this.childNodes
      .map((node) => {
        if (node instanceof TextNode) return node.textContent;
        const attrs = Object.entries(node.attributes)
          .map(([key, value]) => ` ${key}="${value}"`)
          .join("");
        return `<${node.tagName.toLowerCase()}${attrs}>${node.innerHTML}</${node.tagName.toLowerCase()}>`;
      })
      .join("");
  }

  get classList(): { contains: (name: string) => boolean } {
    return { contains: (name) => (this.attributes.class ?? "").split(/\s+/).includes(name) };
  }

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }

  getClientRects(): number[] {
    return this.visible ? [1] : [];
  }

  focus(): void {
    this.onFocus?.();
  }

  click(): void {
    this.onClick?.();
    this.onAfterClick?.();
  }

  querySelector(selector: string): ElementNode | null {
    for (const child of this.children) {
      if (selector === ".message-text" && child.classList.contains("message-text")) return child;
      if (selector === "code" && child.tagName === "CODE") return child;
      const nested = child.querySelector(selector);
      if (nested) return nested;
    }
    return null;
  }

  cloneNode(deep: boolean): ElementNode {
    return new ElementNode(
      this.tagName,
      { ...this.attributes },
      deep
        ? this.childNodes.map((child) =>
            child instanceof ElementNode ? child.cloneNode(true) : new TextNode(child.textContent),
          )
        : [],
    );
  }
}

function element(
  tag: string,
  children: Array<ElementNode | TextNode | string>,
  attributes: Record<string, string> = {},
): ElementNode {
  return new ElementNode(tag.toUpperCase(), attributes, children);
}

function message(
  id: string,
  text: string | ElementNode[],
  options: { self?: boolean; pending?: boolean } = {},
): ElementNode {
  return element(
    "article",
    [element("div", typeof text === "string" ? [text] : text, { class: "message-text" })],
    {
      "data-message-id": id,
      class: ["message-row", options.self ? "self" : "", options.pending ? "pending" : ""]
        .filter(Boolean)
        .join(" "),
    },
  );
}

function completedMessage(
  id: string,
  text: string | ElementNode[],
  marker = TEST_COMPLETION_MARKER,
): ElementNode {
  return message(
    id,
    typeof text === "string" ? `${text}\n${marker}` : [...text, element("p", [marker])],
  );
}

function requestMarkerParagraphs(marker = TEST_COMPLETION_MARKER): ElementNode[] {
  return [
    element("p", [element("br", [], { class: "ProseMirror-trailingBreak" })]),
    element("p", ["Oracle request marker:"]),
    element("p", [marker]),
    element("p", ["Emit this marker only after completing the request."]),
  ];
}

function fixture() {
  const editor = element("div", [], { contenteditable: "true", role: "textbox" });
  const button = element("button", [], { "aria-label": "Send" });
  const body = element("body", []);
  const rows: ElementNode[] = [];
  const document = {
    activeElement: null as ElementNode | null,
    body,
    querySelector: (selector: string): ElementNode | null => {
      if (selector === DOTS_SELECTORS.input) return state.hasEditor ? editor : null;
      if (selector === DOTS_SELECTORS.sendButton) return button;
      if (selector === DOTS_SELECTORS.typing) return state.indicator;
      if (selector.includes('[role="alert"]')) return state.alert;
      if (selector.includes("/auth/login")) return state.login ? element("a", []) : null;
      throw new Error(`Unexpected selector: ${selector}`);
    },
    querySelectorAll: (selector: string): ElementNode[] => {
      if (selector === DOTS_SELECTORS.message) return rows;
      throw new Error(`Unexpected selector: ${selector}`);
    },
  };
  const state = {
    hasEditor: true,
    indicator: element("div", [], { "data-visible": "false" }) as ElementNode | null,
    alert: null as ElementNode | null,
    login: false,
    onDelay: (_now: number) => {},
  };
  editor.onFocus = () => {
    document.activeElement = editor;
  };
  button.onAfterClick = () => {
    editor.childNodes = [];
    delete editor.innerTextOverride;
  };
  const sandbox = vm.createContext({ document });
  const inserted = vi.fn(async (text: string) => {
    editor.textContent = text;
  });
  const providerState: DotsDomProviderState = {
    inputTimeoutMs: 1_500,
    timeoutMs: 8_000,
    insertText: inserted,
    completionMarker: TEST_COMPLETION_MARKER,
  };
  const evaluate = vi.fn(async (expression: string) => vm.runInContext(expression, sandbox));
  const context: ProviderDomFlowContext = {
    prompt: requestPrompt("This is my exact prompt."),
    state: providerState as unknown as Record<string, unknown>,
    evaluate,
    delay: async (ms) => {
      vi.setSystemTime(Date.now() + ms);
      state.onDelay(Date.now());
    },
  };
  const accept = (answer = "Fresh response.") => {
    button.onClick = () => {
      rows.push(message("Sentinel_user", context.prompt, { self: true }));
      editor.textContent = "";
      if (answer) rows.push(completedMessage("Sentinel_answer", answer));
    };
  };
  accept();
  return { context, providerState, editor, button, body, rows, state, inserted, evaluate, accept };
}

describe("Dots DOM provider", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("anchors the answer to the new user message and ignores previous replies and proactive messages", async () => {
    const f = fixture();
    f.rows.push(
      message("old-user", f.context.prompt, { self: true }),
      message("old-answer", "Old response."),
    );
    f.button.onClick = () => {
      f.rows.push(message("proactive", "Unrelated proactive update."));
      f.rows.push(message("Sentinel_user", f.context.prompt, { self: true }));
      f.rows.push(completedMessage("Sentinel_answer", "Fresh response."));
    };
    const result = await runProviderDomFlow(dotsDomProvider, f.context);
    expect(result.text).toBe("Fresh response.");
    expect(result.meta?.messageId).toBe("Sentinel_answer");
    expect(result.thoughts).toBeNull();
    expect(Date.now()).toBeGreaterThanOrEqual(3_000);
  });

  it("waits for the pending user UUID to be replaced with a saved message ID", async () => {
    const f = fixture();
    const submitted = vi.fn(async () => {});
    f.providerState.onPromptSubmitted = submitted;
    f.button.onClick = () => {
      f.rows.push(message("temporary-uuid", f.context.prompt, { self: true, pending: true }));
    };
    f.state.onDelay = (now) => {
      if (now === 500) {
        f.rows.splice(0, 1, message("Sentinel_saved_user", f.context.prompt, { self: true }));
        f.rows.push(completedMessage("Sentinel_answer", "Saved reply."));
      }
    };
    const result = await runProviderDomFlow(dotsDomProvider, f.context);
    expect(result.text).toBe("Saved reply.");
    expect(f.providerState.userMessageId).toBe("Sentinel_saved_user");
    expect(submitted).toHaveBeenCalledOnce();
  });

  it("safely reacquires the submitted user message when its ID changes after pending is removed", async () => {
    const f = fixture();
    f.button.onClick = () => {
      f.rows.push(
        message("optimistic-uuid", f.context.prompt, { self: true }),
        completedMessage("Sentinel_answer", "Fresh response."),
      );
    };
    f.state.onDelay = (now) => {
      if (now === 500) f.rows[0].attributes["data-message-id"] = "Sentinel_saved_user";
    };
    const result = await runProviderDomFlow(dotsDomProvider, f.context);
    expect(result.text).toBe("Fresh response.");
    expect(f.providerState.userMessageId).toBe("Sentinel_saved_user");
    expect(Date.now()).toBeGreaterThanOrEqual(3_500);
  });

  it("follows an optimistic raw Markdown user message when its ID and rendered Markdown shape change together", async () => {
    const f = fixture();
    f.context.prompt = requestPrompt(
      "### File: sample.txt\nLines: 1-3\n```\n1 | Alpha\n\n3 | Omega\n```",
    );
    f.button.onClick = () => {
      f.rows.push(
        message("optimistic-uuid", f.context.prompt, { self: true }),
        completedMessage("Sentinel_answer", "Accepted."),
      );
    };
    f.state.onDelay = (now) => {
      if (now === 500) {
        f.rows[0] = message(
          "Sentinel_saved_user",
          [
            element("h3", ["File: sample.txt"]),
            element("p", ["Lines: 1-3"]),
            element("pre", [
              element("code", ["1 | Alpha\n\n3 | Omega\n"], { class: "language-plaintext" }),
            ]),
            ...requestMarkerParagraphs(),
          ],
          { self: true },
        );
      }
    };
    expect((await runProviderDomFlow(dotsDomProvider, f.context)).text).toBe("Accepted.");
    expect(f.providerState.userMessageId).toBe("Sentinel_saved_user");
  });

  it("does not reacquire a user replacement lacking this turn's request marker", async () => {
    const f = fixture();
    f.context.prompt = requestPrompt("```\nFirst\n\nSecond\n```");
    f.state.onDelay = (now) => {
      if (now === 500) {
        f.rows[0] = message(
          "different-user",
          [element("pre", [element("code", ["First\nSecond\n"])])],
          { self: true },
        );
      }
    };
    await expect(runProviderDomFlow(dotsDomProvider, f.context)).rejects.toThrow(
      "replacement could not be confirmed",
    );
  });

  it.each(["list", "bold", "link", "inline-code", "fenced-code"])(
    "tracks the same request nonce when %s Markdown renders while the optimistic ID changes",
    async (kind) => {
      const f = fixture();
      let source: string;
      let rendered: ElementNode;
      if (kind === "list") {
        source = "* Alpha";
        rendered = element("ul", [element("li", ["Alpha"])]);
      } else if (kind === "bold") {
        source = "__Alpha__";
        rendered = element("p", [element("strong", ["Alpha"])]);
      } else if (kind === "link") {
        source = "[Alpha](https://example.com)";
        rendered = element("p", [element("a", ["Alpha"], { href: "https://example.com" })]);
      } else if (kind === "inline-code") {
        source = "`Alpha`";
        rendered = element("p", [element("code", ["Alpha"])]);
      } else {
        source = "~~~javascript\nconst value = 'Alpha';\n~~~";
        rendered = element("pre", [
          element("code", ["const value = 'Alpha';\n"], { class: "language-javascript" }),
        ]);
      }
      f.context.prompt = requestPrompt(source);
      f.button.onClick = () => {
        f.rows.push(
          message("optimistic-uuid", f.context.prompt, { self: true }),
          completedMessage("final", "Accepted."),
        );
      };
      f.state.onDelay = (now) => {
        if (now === 500)
          f.rows[0] = message("Sentinel_saved_user", [rendered, ...requestMarkerParagraphs()], {
            self: true,
          });
      };
      expect((await runProviderDomFlow(dotsDomProvider, f.context)).text).toBe("Accepted.");
      expect(f.providerState.userMessageId).toBe("Sentinel_saved_user");
      expect(f.inserted).toHaveBeenCalledWith(f.context.prompt);
    },
  );

  it.each(["missing", "old-turn", "substring"])(
    "does not confirm a fresh user row carrying a %s request marker",
    async (kind) => {
      const f = fixture();
      const content =
        kind === "missing"
          ? "Unrelated message."
          : kind === "old-turn"
            ? requestPrompt("Other turn.", "ORACLE-DOTS-DONE-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")
            : "Prefix " + TEST_COMPLETION_MARKER + " suffix";
      f.button.onClick = () => {
        f.rows.push(
          message("unconfirmed-user", content, { self: true }),
          completedMessage("answer", "Unrelated answer."),
        );
      };
      await expect(runProviderDomFlow(dotsDomProvider, f.context)).rejects.toThrow(
        "do not retry automatically",
      );
      expect(f.providerState.userMessageId).toBeUndefined();
    },
  );

  it("accepts the exact request nonce as a user message code line while requiring plain-text assistant completion", async () => {
    const f = fixture();
    f.button.onClick = () => {
      f.rows.push(
        message(
          "Sentinel_user",
          [
            element("p", ["Request protocol:"]),
            element("pre", [element("code", [TEST_COMPLETION_MARKER + "\n"])]),
            element("p", ["Only emit after completion."]),
          ],
          { self: true },
        ),
        completedMessage("answer", "Accepted."),
      );
    };
    expect((await runProviderDomFlow(dotsDomProvider, f.context)).text).toBe("Accepted.");
  });

  it("rejects a prompt missing the state request marker before typing or sending", async () => {
    const f = fixture();
    f.context.prompt = "A prompt without the per-turn nonce.";
    const click = vi.fn();
    f.button.onClick = click;
    await expect(runProviderDomFlow(dotsDomProvider, f.context)).rejects.toThrow(
      "request marker on its own line",
    );
    expect(f.inserted).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
  });

  it("does not treat changing rendering attributes as answer content changes", async () => {
    const f = fixture();
    const paragraph = element("p", ["Completed response."], { "data-tick": "0" });
    f.button.onClick = () => {
      f.rows.push(
        message("Sentinel_user", f.context.prompt, { self: true }),
        completedMessage("Sentinel_answer", [paragraph]),
      );
    };
    f.state.onDelay = (now) => {
      paragraph.attributes["data-tick"] = String(now);
    };
    const result = await runProviderDomFlow(dotsDomProvider, f.context);
    expect(result.text).toBe("Completed response.");
    expect(result.html).toContain('data-tick="3000"');
    expect(Date.now()).toBe(3_000);
  });

  it("keeps waiting while typing is true and combines multiple assistant messages", async () => {
    const f = fixture();
    f.button.onClick = () => {
      f.rows.push(message("Sentinel_user", f.context.prompt, { self: true }));
      f.rows.push(message("Sentinel_preface", "I will read the attachment."));
      f.state.indicator!.attributes["data-visible"] = "true";
    };
    f.state.onDelay = (now) => {
      if (now === 2_000) {
        f.rows.push(completedMessage("Sentinel_final", "VERIFICATION_TOKEN"));
        f.state.indicator!.attributes["data-visible"] = "false";
      }
    };
    const result = await runProviderDomFlow(dotsDomProvider, f.context);
    expect(result.text).toBe("I will read the attachment.\n\nVERIFICATION_TOKEN");
    expect(result.meta?.messageId).toBe("Sentinel_final");
    expect(Date.now()).toBeGreaterThanOrEqual(5_000);
  });

  it("restarts the completion window if more content arrives while idle", async () => {
    const f = fixture();
    f.state.onDelay = (now) => {
      if (now === 2_500) f.rows.push(completedMessage("Sentinel_final", "Second part."));
    };
    const result = await runProviderDomFlow(dotsDomProvider, f.context);
    expect(result.text).toBe("Fresh response.\n\nSecond part.");
    expect(Date.now()).toBeGreaterThanOrEqual(5_500);
  });

  it.each(["missing", "unknown", "busy"])(
    "uses the explicit marker while the typing indicator is %s",
    async (status) => {
      const f = fixture();
      f.button.onClick = () => {
        f.rows.push(
          message("Sentinel_user", f.context.prompt, { self: true }),
          completedMessage("Sentinel_answer", "Partial response."),
        );
        if (status === "missing") f.state.indicator = null;
        else f.state.indicator!.attributes["data-visible"] = status === "busy" ? "true" : "unknown";
      };
      if (status === "busy") {
        await expect(runProviderDomFlow(dotsDomProvider, f.context)).rejects.toThrow(
          "explicit completion marker",
        );
      } else {
        expect((await runProviderDomFlow(dotsDomProvider, f.context)).text).toBe(
          "Partial response.",
        );
      }
    },
  );

  it("does not finish a long idle prelude before the tool result and this turn's marker arrive", async () => {
    const f = fixture();
    f.providerState.timeoutMs = 16_000;
    f.button.onClick = () => {
      f.rows.push(
        message("Sentinel_user", f.context.prompt, { self: true }),
        message("prelude", "I will fetch and read the attachment."),
      );
    };
    f.state.onDelay = (now) => {
      if (now === 8_000)
        f.rows.push(completedMessage("final", "Verified attachment token: TOKEN."));
    };
    const result = await runProviderDomFlow(dotsDomProvider, f.context);
    expect(result.text).toBe(
      "I will fetch and read the attachment.\n\nVerified attachment token: TOKEN.",
    );
    expect(Date.now()).toBeGreaterThanOrEqual(11_000);
  });

  it("fails closed when only an idle prelude exists without a completion marker", async () => {
    const f = fixture();
    f.button.onClick = () => {
      f.rows.push(
        message("Sentinel_user", f.context.prompt, { self: true }),
        message("prelude", "I will read the attachment."),
      );
    };
    await expect(runProviderDomFlow(dotsDomProvider, f.context)).rejects.toThrow(
      "explicit completion marker",
    );
  });

  it.each(["fenced-code", "inline-code", "blockquote", "heading", "bold", "unclosed-fence"])(
    "does not accept a completion token inside %s",
    async (kind) => {
      const f = fixture();
      let content: string | ElementNode[];
      if (kind === "fenced-code")
        content = [element("pre", [element("code", [TEST_COMPLETION_MARKER])])];
      else if (kind === "inline-code")
        content = [element("p", [element("code", [TEST_COMPLETION_MARKER])])];
      else if (kind === "blockquote")
        content = [element("blockquote", [element("p", [TEST_COMPLETION_MARKER])])];
      else if (kind === "heading") content = [element("h3", [TEST_COMPLETION_MARKER])];
      else if (kind === "bold")
        content = [element("p", [element("strong", [TEST_COMPLETION_MARKER])])];
      else content = "```text\n" + TEST_COMPLETION_MARKER;
      f.button.onClick = () => {
        f.rows.push(
          message("Sentinel_user", f.context.prompt, { self: true }),
          message("not-final", content),
        );
      };
      await expect(runProviderDomFlow(dotsDomProvider, f.context)).rejects.toThrow(
        "explicit completion marker",
      );
    },
  );

  it("does not accept this turn's token from old history or another turn's footer", async () => {
    const f = fixture();
    f.rows.push(completedMessage("old-answer", "Old answer."));
    f.button.onClick = () => {
      f.rows.push(
        message("Sentinel_user", f.context.prompt, { self: true }),
        completedMessage(
          "wrong-turn",
          "Other turn.",
          "ORACLE-DOTS-DONE-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        ),
      );
    };
    await expect(runProviderDomFlow(dotsDomProvider, f.context)).rejects.toThrow(
      "explicit completion marker",
    );
  });

  it("requires the token in the latest assistant message and only on its final standalone line", async () => {
    const f = fixture();
    f.button.onClick = () => {
      f.rows.push(
        message("Sentinel_user", f.context.prompt, { self: true }),
        completedMessage("earlier-final", "Earlier answer."),
        message("new-progress", "Still working.\nToken: " + TEST_COMPLETION_MARKER),
      );
    };
    await expect(runProviderDomFlow(dotsDomProvider, f.context)).rejects.toThrow(
      "explicit completion marker",
    );
  });

  it("removes the current footer from text and HTML while preserving interior tokens and prior messages", async () => {
    const f = fixture();
    const oldToken = "ORACLE-DOTS-DONE-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    f.button.onClick = () => {
      f.rows.push(
        message("Sentinel_user", f.context.prompt, { self: true }),
        message("progress", "Read complete."),
        completedMessage("final", [
          element("p", ["Quoted old token: " + oldToken]),
          element("pre", [element("code", [TEST_COMPLETION_MARKER])]),
          element("p", ["Actual result."]),
        ]),
      );
    };
    const result = await runProviderDomFlow(dotsDomProvider, f.context);
    expect(result.text).toContain("Read complete.");
    expect(result.text).toContain(oldToken);
    expect(result.text).toContain("```\n" + TEST_COMPLETION_MARKER + "\n```");
    expect(result.text.endsWith("Actual result.")).toBe(true);
    expect(result.html?.split(TEST_COMPLETION_MARKER).length).toBe(2);
  });

  it("combines meaningful messages and drops repeated footer-only assistant messages", async () => {
    const f = fixture();
    f.button.onClick = () => {
      f.rows.push(
        message("Sentinel_user", f.context.prompt, { self: true }),
        message("answer", "Actual result."),
        message("footer-one", TEST_COMPLETION_MARKER),
        message("footer-two", [element("p", [TEST_COMPLETION_MARKER])]),
      );
    };
    const result = await runProviderDomFlow(dotsDomProvider, f.context);
    expect(result.text).toBe("Actual result.");
    expect(result.html).toBe("Actual result.");
    expect(result.meta?.messageId).toBe("footer-two");
  });

  it("does not return an empty result when the only message is a completion footer", async () => {
    const f = fixture();
    f.button.onClick = () => {
      f.rows.push(
        message("Sentinel_user", f.context.prompt, { self: true }),
        message("footer-only", TEST_COMPLETION_MARKER),
      );
    };
    await expect(runProviderDomFlow(dotsDomProvider, f.context)).rejects.toThrow(
      "explicit completion marker",
    );
  });

  it("rejects a missing completion marker before typing or sending", async () => {
    const f = fixture();
    delete f.providerState.completionMarker;
    const click = vi.fn();
    f.button.onClick = click;
    await expect(runProviderDomFlow(dotsDomProvider, f.context)).rejects.toThrow(
      "unique completion marker",
    );
    expect(click).not.toHaveBeenCalled();
    expect(f.inserted).not.toHaveBeenCalled();
  });

  it("never returns the submitted user message as the answer", async () => {
    const f = fixture();
    f.accept("");
    await expect(runProviderDomFlow(dotsDomProvider, f.context)).rejects.toThrow(
      "Timed out waiting for Dots",
    );
  });

  it("does not return a historical assistant row moved after the anchor", async () => {
    const f = fixture();
    const old = message("old-answer", "Historical answer.");
    f.rows.push(old);
    f.button.onClick = () => {
      f.rows.splice(0, 1);
      f.rows.push(message("Sentinel_user", f.context.prompt, { self: true }), old);
    };
    await expect(runProviderDomFlow(dotsDomProvider, f.context)).rejects.toThrow(
      "Timed out confirming the submitted Dots user message",
    );
  });

  it("rejects a competing user message during submission", async () => {
    const f = fixture();
    f.button.onClick = () => {
      f.rows.push(message("Sentinel_user", f.context.prompt, { self: true }));
      f.rows.push(message("another-user", "Other question.", { self: true }));
    };
    await expect(runProviderDomFlow(dotsDomProvider, f.context)).rejects.toThrow(
      "during submission",
    );
  });

  it("rejects a competing user message while waiting for the answer", async () => {
    const f = fixture();
    f.state.onDelay = (now) => {
      if (now === 1_000)
        f.rows.push(message("another-user", "Other question.", { self: true, pending: true }));
    };
    await expect(runProviderDomFlow(dotsDomProvider, f.context)).rejects.toThrow(
      "after this Dots prompt",
    );
  });

  it("fails closed rather than reacquiring an ambiguous identical prompt", async () => {
    const f = fixture();
    f.state.onDelay = (now) => {
      if (now === 500) {
        f.rows[0].attributes["data-message-id"] = "Sentinel_saved_user";
        f.rows.push(message("other-identical-prompt", f.context.prompt, { self: true }));
      }
    };
    await expect(runProviderDomFlow(dotsDomProvider, f.context)).rejects.toThrow(
      "cannot be attributed safely",
    );
  });

  it("preserves an existing draft without typing or sending", async () => {
    const f = fixture();
    f.editor.textContent = "My unsent draft.";
    const click = vi.fn();
    f.button.onClick = click;
    await expect(runProviderDomFlow(dotsDomProvider, f.context)).rejects.toThrow("existing draft");
    expect(f.editor.textContent).toBe("My unsent draft.");
    expect(f.inserted).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
  });

  it("preserves a draft that appears during attachment upload", async () => {
    const f = fixture();
    f.providerState.attachments = [{ path: "/tmp/example.txt", name: "example.txt" }];
    f.context.uploadAttachments = async () => {
      f.editor.textContent = "Concurrent draft.";
    };
    await expect(runProviderDomFlow(dotsDomProvider, f.context)).rejects.toThrow(
      "contents were preserved",
    );
    expect(f.editor.textContent).toBe("Concurrent draft.");
    expect(f.inserted).not.toHaveBeenCalled();
  });

  it("uploads before using trusted text insertion and preserves multiline prompts", async () => {
    const f = fixture();
    f.context.prompt = requestPrompt("First line.\n  Indented second line.\n第三行。");
    const attachments = [{ path: "/tmp/example.txt", name: "example.txt" }];
    f.providerState.attachments = attachments;
    const order: string[] = [];
    f.context.uploadAttachments = vi.fn(async () => {
      order.push("upload");
    });
    f.providerState.insertText = async (text) => {
      order.push("type");
      f.editor.textContent = text;
    };
    expect((await runProviderDomFlow(dotsDomProvider, f.context)).text).toBe("Fresh response.");
    expect(order).toEqual(["upload", "type"]);
    expect(f.context.uploadAttachments).toHaveBeenCalledWith(attachments);
  });

  it("serializes ProseMirror paragraphs and empty paragraphs consistently through typing, submission, and the user anchor", async () => {
    const f = fixture();
    f.context.prompt = requestPrompt(
      "First line.\n\n### File: sample.txt\nLines: 1-3\n```\n1 | Alpha\n2 | TOKEN\n3 | Omega\n```",
    );
    const paragraphs = [
      element("p", ["First line."]),
      element("p", [element("br", [], { class: "ProseMirror-trailingBreak" })], {
        "data-empty-paragraph": "true",
      }),
      element("p", ["### File: sample.txt"]),
      element("p", ["Lines: 1-3"]),
      element("p", ["```"]),
      element("p", ["1 | Alpha"]),
      element("p", ["2 | TOKEN"]),
      element("p", ["3 | Omega"]),
      element("p", ["```"]),
      ...requestMarkerParagraphs(),
    ];
    const visualText =
      "First line.\n\n\n\n\n### File: sample.txt\n\nLines: 1-3\n\n```\n\n1 | Alpha\n\n2 | TOKEN\n\n3 | Omega\n\n```";
    f.providerState.insertText = async () => {
      f.editor.childNodes = paragraphs;
      f.editor.innerTextOverride = visualText;
    };
    f.button.onClick = () => {
      const user = message("Sentinel_user", paragraphs, { self: true });
      user.querySelector(".message-text")!.innerTextOverride = visualText;
      f.rows.push(user, completedMessage("Sentinel_answer", "TOKEN"));
      f.editor.childNodes = [];
    };
    const result = await runProviderDomFlow(dotsDomProvider, f.context);
    expect(result.text).toBe("TOKEN");
    expect(f.providerState.userMessageId).toBe("Sentinel_user");
  });

  it("preserves BR line breaks and ignores ProseMirror's final layout break", async () => {
    const f = fixture();
    f.context.prompt = requestPrompt("First\nSecond\n\nThird");
    const paragraphs = [
      element("p", [
        "First",
        element("br", []),
        "Second",
        element("br", [], { class: "ProseMirror-trailingBreak" }),
      ]),
      element("p", [element("br", [])], { "data-empty-paragraph": "true" }),
      element("p", ["Third"]),
      ...requestMarkerParagraphs(),
    ];
    f.providerState.insertText = async () => {
      f.editor.childNodes = paragraphs;
    };
    f.button.onClick = () => {
      f.rows.push(
        message("Sentinel_user", paragraphs, { self: true }),
        completedMessage("Sentinel_answer", "Accepted."),
      );
    };
    expect((await runProviderDomFlow(dotsDomProvider, f.context)).text).toBe("Accepted.");
  });

  it("rejects a missing real empty paragraph rather than collapsing prompt whitespace", async () => {
    const f = fixture();
    f.context.prompt = requestPrompt("First\n\nSecond");
    f.providerState.insertText = async () => {
      f.editor.childNodes = [
        element("p", ["First"]),
        element("p", ["Second"]),
        ...requestMarkerParagraphs(),
      ];
      f.editor.innerTextOverride = "First\n\nSecond";
    };
    const click = vi.fn();
    f.button.onClick = click;
    await expect(runProviderDomFlow(dotsDomProvider, f.context)).rejects.toThrow("complete prompt");
    expect(click).not.toHaveBeenCalled();
  });

  it("verifies logical paragraph contents again at submission when visual innerText looks unchanged", async () => {
    const f = fixture();
    f.context.prompt = requestPrompt("First\n\nSecond");
    f.providerState.insertText = async () => {
      f.editor.childNodes = [
        element("p", ["First"]),
        element("p", [element("br", [], { class: "ProseMirror-trailingBreak" })]),
        element("p", ["Second"]),
        ...requestMarkerParagraphs(),
      ];
    };
    await dotsDomProvider.typePrompt(f.context);
    f.editor.childNodes.splice(1, 1);
    f.editor.innerTextOverride = f.context.prompt;
    const click = vi.fn();
    f.button.onClick = click;
    await expect(dotsDomProvider.submitPrompt(f.context)).rejects.toThrow("draft-changed");
    expect(click).not.toHaveBeenCalled();
  });

  it("anchors a literal Markdown source prompt to its H3, paragraph, and code-rendered user bubble", async () => {
    const f = fixture();
    f.context.prompt = requestPrompt(
      "### File: sample.txt\nLines: 1-3\n```\n1 | Alpha\n2 | TOKEN\n3 | Omega\n```",
    );
    f.providerState.insertText = async (text) => {
      f.editor.childNodes = text.split("\n").map((line) => element("p", [line]));
    };
    f.button.onClick = () => {
      f.rows.push(
        message(
          "Sentinel_user",
          [
            element("h3", ["File: sample.txt"]),
            element("p", ["Lines: 1-3"]),
            element("pre", [element("code", ["1 | Alpha\n2 | TOKEN\n3 | Omega\n"])]),
            ...requestMarkerParagraphs(),
          ],
          { self: true },
        ),
        completedMessage("Sentinel_answer", "TOKEN"),
      );
    };
    expect((await runProviderDomFlow(dotsDomProvider, f.context)).text).toBe("TOKEN");
  });

  it("does not attribute a fresh user row until the verified composer has cleared", async () => {
    const f = fixture();
    f.button.onAfterClick = undefined;
    f.button.onClick = () => {
      f.rows.push(message("Sentinel_user", f.context.prompt, { self: true }));
    };
    await expect(runProviderDomFlow(dotsDomProvider, f.context)).rejects.toThrow(
      "do not retry automatically",
    );
    expect(f.providerState.userMessageId).toBeUndefined();
    expect(f.editor.textContent).toBe(f.context.prompt);
  });

  it("ignores older history prepended between typing and submission", async () => {
    const f = fixture();
    f.rows.push(message("known-last", "Known latest history."));
    await dotsDomProvider.typePrompt(f.context);
    f.rows.unshift(
      message("older-user", "Older question.", { self: true }),
      message("older-answer", "Older answer."),
    );
    await dotsDomProvider.submitPrompt(f.context);
    expect((await dotsDomProvider.waitForResponse(f.context)).text).toBe("Fresh response.");
  });

  it("ignores older history hydrating during saved-message confirmation", async () => {
    const f = fixture();
    f.rows.push(message("known-last", "Known latest history."));
    const pending = message("optimistic", f.context.prompt, { self: true, pending: true });
    f.button.onClick = () => {
      f.rows.push(pending);
    };
    f.state.onDelay = (now) => {
      if (now === 500) {
        f.rows.unshift(message("older-user", "Older question.", { self: true }));
        pending.attributes.class = "message-row self";
        pending.attributes["data-message-id"] = "Sentinel_user";
        f.rows.push(completedMessage("Sentinel_answer", "Accepted."));
      }
    };
    expect((await runProviderDomFlow(dotsDomProvider, f.context)).text).toBe("Accepted.");
  });

  it("ignores a viewport expansion with older users while reacquiring this user's changed ID", async () => {
    const f = fixture();
    f.rows.push(message("known-last", "Known latest history."));
    f.state.onDelay = (now) => {
      if (now === 500) {
        f.rows[1].attributes["data-message-id"] = "Sentinel_saved_user";
        f.rows.unshift(
          message("older-user", f.context.prompt, { self: true }),
          message("older-answer", "Older answer."),
        );
      }
    };
    expect((await runProviderDomFlow(dotsDomProvider, f.context)).text).toBe("Fresh response.");
    expect(f.providerState.userMessageId).toBe("Sentinel_saved_user");
  });

  it("fails safely if a nonempty baseline disappears before submission", async () => {
    const f = fixture();
    f.rows.push(message("known-last", "Known latest history."));
    await dotsDomProvider.typePrompt(f.context);
    f.rows.splice(0);
    const click = vi.fn();
    f.button.onClick = click;
    await expect(dotsDomProvider.submitPrompt(f.context)).rejects.toThrow(
      "baseline is no longer visible",
    );
    expect(click).not.toHaveBeenCalled();
  });

  it("fails safely if all known baseline rows disappear while waiting for the answer", async () => {
    const f = fixture();
    f.rows.push(message("known-last", "Known latest history."));
    f.state.onDelay = (now) => {
      if (now === 500) f.rows.splice(0, 1);
    };
    await expect(runProviderDomFlow(dotsDomProvider, f.context)).rejects.toThrow(
      "baseline is no longer visible",
    );
  });

  it("rejects a competing fresh user between the known baseline and this prompt", async () => {
    const f = fixture();
    f.rows.push(message("known-last", "Known latest history."));
    f.state.onDelay = (now) => {
      if (now === 500)
        f.rows.splice(1, 0, message("competing-user", "Other question.", { self: true }));
    };
    await expect(runProviderDomFlow(dotsDomProvider, f.context)).rejects.toThrow(
      "cannot be attributed safely",
    );
  });

  it("preserves a paragraph draft containing real text even when innerText is empty", async () => {
    const f = fixture();
    f.editor.childNodes = [element("p", [element("br", [])]), element("p", ["Existing draft."])];
    f.editor.innerTextOverride = "";
    await expect(dotsDomProvider.waitForUi(f.context)).rejects.toThrow("existing draft");
    expect(f.editor.textContent).toBe("Existing draft.");
    expect(f.inserted).not.toHaveBeenCalled();
  });

  it("does not send a prompt if trusted insertion truncates it", async () => {
    const f = fixture();
    f.providerState.insertText = async () => {
      f.editor.textContent = "truncated";
    };
    const click = vi.fn();
    f.button.onClick = click;
    await expect(runProviderDomFlow(dotsDomProvider, f.context)).rejects.toThrow("complete prompt");
    expect(click).not.toHaveBeenCalled();
  });

  it("rejects a prompt changed after typing before clicking Send", async () => {
    const f = fixture();
    await dotsDomProvider.waitForUi(f.context);
    await dotsDomProvider.typePrompt(f.context);
    f.editor.textContent = "Changed draft.";
    const click = vi.fn();
    f.button.onClick = click;
    await expect(dotsDomProvider.submitPrompt(f.context)).rejects.toThrow("draft-changed");
    expect(click).not.toHaveBeenCalled();
  });

  it("rejects another user message arriving before submission", async () => {
    const f = fixture();
    await dotsDomProvider.typePrompt(f.context);
    f.rows.push(message("another-user", "Other question.", { self: true }));
    await expect(dotsDomProvider.submitPrompt(f.context)).rejects.toThrow("before submission");
  });

  it("reports login, verification, and page error states", async () => {
    const login = fixture();
    login.state.hasEditor = false;
    login.state.login = true;
    await expect(dotsDomProvider.waitForUi(login.context)).rejects.toThrow("requires sign-in");
    const challenge = fixture();
    challenge.state.hasEditor = false;
    challenge.body.textContent = "Verify you are human";
    await expect(dotsDomProvider.waitForUi(challenge.context)).rejects.toThrow(
      "verification challenge",
    );
    const error = fixture();
    error.state.alert = element("div", ["Message could not be sent."]);
    await expect(dotsDomProvider.waitForUi(error.context)).rejects.toThrow(
      "Message could not be sent",
    );
  });

  it("does not mistake historical Cloudflare challenge phrases for a challenge with a usable composer", async () => {
    const f = fixture();
    f.body.textContent =
      "A previous reply discussed 'verify you are human' and 'checking your browser'.";
    f.rows.push(
      message("old-answer", "To debug Cloudflare: verify you are human; checking your browser."),
    );
    expect((await runProviderDomFlow(dotsDomProvider, f.context)).text).toBe("Fresh response.");
  });

  it("rejects an existing in-flight message before typing", async () => {
    const busy = fixture();
    busy.state.indicator!.attributes["data-visible"] = "true";
    await expect(dotsDomProvider.waitForUi(busy.context)).rejects.toThrow("already processing");
    const pending = fixture();
    pending.rows.push(message("pending", "Existing question.", { self: true, pending: true }));
    await expect(dotsDomProvider.waitForUi(pending.context)).rejects.toThrow("already processing");
  });

  it("times out when the UI or send button never becomes usable", async () => {
    const absent = fixture();
    absent.state.hasEditor = false;
    await expect(dotsDomProvider.waitForUi(absent.context)).rejects.toThrow("prompt input");
    const disabled = fixture();
    disabled.button.disabled = true;
    await expect(dotsDomProvider.typePrompt(disabled.context)).rejects.toThrow("send button");
  });

  it("does not confirm a pending user message that was never saved", async () => {
    const f = fixture();
    f.button.onClick = () => {
      f.rows.push(message("pending", f.context.prompt, { self: true, pending: true }));
    };
    const callback = vi.fn(async () => {});
    f.providerState.onPromptSubmitted = callback;
    await expect(runProviderDomFlow(dotsDomProvider, f.context)).rejects.toThrow(
      "do not retry automatically",
    );
    expect(callback).toHaveBeenCalledOnce();
  });

  it("includes only state and IDs in timeout diagnostics when the submitted anchor disappears", async () => {
    const f = fixture();
    f.accept("PRIVATE_ANSWER_TEXT");
    f.state.onDelay = (now) => {
      if (now === 500) f.rows.splice(0, 1);
    };
    const failure = await runProviderDomFlow(dotsDomProvider, f.context).then(
      () => null,
      (error: Error) => error,
    );
    expect(failure?.message).toContain('"anchorFound":false');
    expect(failure?.message).toContain('"anchorId":"Sentinel_user"');
    expect(failure?.message).toContain('"typing":false');
    expect(failure?.message).toContain('"messageCount":1');
    expect(failure?.message).not.toContain("PRIVATE_ANSWER_TEXT");
    expect(failure?.message).not.toContain(f.context.prompt);
  });

  it("requires trusted text insertion and an attachment uploader when needed", async () => {
    const f = fixture();
    delete f.providerState.insertText;
    await expect(dotsDomProvider.typePrompt(f.context)).rejects.toThrow(
      "trusted browser text input",
    );
    const attachment = fixture();
    attachment.providerState.attachments = [{ path: "/tmp/file", name: "file" }];
    await expect(dotsDomProvider.typePrompt(attachment.context)).rejects.toThrow(
      "attachment upload is unavailable",
    );
  });

  it("preserves headings, lists, links, emphasis, and fenced code in Markdown", async () => {
    const f = fixture();
    const content = [
      element("h2", ["Result"]),
      element("p", [
        element("strong", ["Read"]),
        " ",
        element("a", ["the docs"], { href: "https://example.com/docs" }),
        ".",
      ]),
      element("ul", [
        element("li", ["First"]),
        element("li", ["Second ", element("code", ["value"])]),
      ]),
      element("pre", [
        element("code", ["const n = 1;\n\nconsole.log(n);\n"], { class: "language-javascript" }),
      ]),
    ];
    f.button.onClick = () => {
      f.rows.push(
        message("Sentinel_user", f.context.prompt, { self: true }),
        completedMessage("Sentinel_answer", content),
      );
    };
    const result = await runProviderDomFlow(dotsDomProvider, f.context);
    expect(result.text).toContain("## Result");
    expect(result.text).toContain("**Read** [the docs](https://example.com/docs)");
    expect(result.text).toContain("- First\n- Second `value`");
    expect(result.text).toContain("```javascript\nconst n = 1;\n\nconsole.log(n);\n```");
    expect(result.html).toContain('<a href="https://example.com/docs">the docs</a>');
  });

  it("preserves table headers, columns, escaped pipes, and cell line breaks in Markdown", async () => {
    const f = fixture();
    const table = element("table", [
      element("caption", ["Comparison"]),
      element("thead", [element("tr", [element("th", ["Name"]), element("th", ["Value"])])]),
      element("tbody", [
        element("tr", [
          element("td", ["Alpha | Beta"]),
          element("td", ["First", element("br", []), "Second"]),
        ]),
        element("tr", [element("td", [element("strong", ["Gamma"])]), element("td", ["3"])]),
      ]),
    ]);
    f.button.onClick = () => {
      f.rows.push(
        message("Sentinel_user", f.context.prompt, { self: true }),
        completedMessage("Sentinel_answer", [table]),
      );
    };
    const result = await runProviderDomFlow(dotsDomProvider, f.context);
    expect(result.text).toBe(
      "Comparison\n\n| Name | Value |\n| --- | --- |\n| Alpha \\| Beta | First<br>Second |\n| **Gamma** | 3 |",
    );
    expect(result.html).toContain("<thead><tr><th>Name</th><th>Value</th></tr></thead>");
  });

  it("synthesizes a blank table header without losing the first data row and pads ragged rows", async () => {
    const f = fixture();
    const table = element("table", [
      element("tbody", [
        element("tr", [element("td", ["First name"]), element("td", ["First value"])]),
        element("tr", [element("td", ["Second name"])]),
      ]),
    ]);
    f.button.onClick = () => {
      f.rows.push(
        message("Sentinel_user", f.context.prompt, { self: true }),
        completedMessage("Sentinel_answer", [table]),
      );
    };
    const result = await runProviderDomFlow(dotsDomProvider, f.context);
    expect(result.text).toBe(
      "|  |  |\n| --- | --- |\n| First name | First value |\n| Second name |  |",
    );
  });

  it("recognizes a header made of th cells without an explicit thead", async () => {
    const f = fixture();
    const table = element("table", [
      element("tr", [element("th", ["Key"]), element("th", ["Description"])]),
      element("tr", [
        element("td", ["api"]),
        element("td", [element("a", ["Docs"], { href: "https://example.com" })]),
      ]),
    ]);
    f.button.onClick = () => {
      f.rows.push(
        message("Sentinel_user", f.context.prompt, { self: true }),
        completedMessage("Sentinel_answer", [table]),
      );
    };
    const result = await runProviderDomFlow(dotsDomProvider, f.context);
    expect(result.text).toBe(
      "| Key | Description |\n| --- | --- |\n| api | [Docs](https://example.com) |",
    );
  });
});
