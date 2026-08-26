import { describe, expect, test, vi } from "vitest";
import type { SessionMetadata } from "../../src/sessionStore.js";
import {
  resolveBrowserFollowupReference,
  resolveBrowserResumeConversationUrl,
} from "../../src/cli/followup.js";

const baseMetadata: SessionMetadata = {
  id: "session-1",
  createdAt: "2026-01-01T00:00:00.000Z",
  status: "completed",
  options: {},
};

describe("browser follow-up resolution", () => {
  test("derives a resume URL from conversationId", () => {
    const metadata: SessionMetadata = {
      ...baseMetadata,
      mode: "browser",
      browser: {
        config: { url: "https://chatgpt.com/" },
        runtime: { conversationId: "abc-123" },
      },
    };

    expect(resolveBrowserResumeConversationUrl(metadata)).toBe("https://chatgpt.com/c/abc-123");
  });

  test("derives a resume URL from tabUrl", () => {
    const metadata: SessionMetadata = {
      ...baseMetadata,
      mode: "browser",
      browser: {
        runtime: { tabUrl: "https://chatgpt.com/c/live-thread" },
      },
    };

    expect(resolveBrowserResumeConversationUrl(metadata)).toBe("https://chatgpt.com/c/live-thread");
  });

  test("resolves stored browser sessions to a browser resume path", async () => {
    const metadata: SessionMetadata = {
      ...baseMetadata,
      id: "browser-slug",
      mode: "browser",
      model: "gpt-5.5-pro",
      browser: {
        config: {
          manualLogin: true,
          manualLoginProfileDir: "/tmp/oracle-profile",
          browserTabRef: "stale-tab",
          researchMode: "deep",
          archiveConversations: "auto",
        },
        runtime: { conversationId: "resume-me" },
      },
    };
    const store = { readSession: vi.fn(async () => metadata) };

    await expect(resolveBrowserFollowupReference("browser-slug", store)).resolves.toEqual({
      sessionId: "browser-slug",
      resumeConversationUrl: "https://chatgpt.com/c/resume-me",
      model: "gpt-5.5-pro",
      browserConfig: {
        manualLogin: true,
        manualLoginProfileDir: "/tmp/oracle-profile",
        browserTabRef: null,
        researchMode: "off",
        archiveConversations: "never",
        resumeConversationUrl: "https://chatgpt.com/c/resume-me",
      },
    });
  });

  test("leaves stored API sessions on the existing API follow-up path", async () => {
    const metadata: SessionMetadata = {
      ...baseMetadata,
      id: "api-slug",
      mode: "api",
      response: { id: "resp_parent" },
    };
    const store = { readSession: vi.fn(async () => metadata) };

    await expect(resolveBrowserFollowupReference("api-slug", store)).resolves.toBeNull();
  });

  test("errors clearly when a browser session has no conversation URL", async () => {
    const metadata: SessionMetadata = {
      ...baseMetadata,
      id: "missing-url",
      mode: "browser",
      browser: { runtime: { chromePort: 9222 } },
    };
    const store = { readSession: vi.fn(async () => metadata) };

    await expect(resolveBrowserFollowupReference("missing-url", store)).rejects.toThrow(
      /does not contain a recoverable provider conversation URL.*oracle status/s,
    );
  });

  test("prefers the harvested URL over a stale runtime tab URL", () => {
    const metadata: SessionMetadata = {
      ...baseMetadata,
      mode: "browser",
      browser: {
        harvest: { url: "https://chatgpt.com/c/harvested" },
        runtime: { tabUrl: "https://chatgpt.com/c/stale-runtime" },
      },
    };

    expect(resolveBrowserResumeConversationUrl(metadata)).toBe("https://chatgpt.com/c/harvested");
  });

  test("rejects an external resume URL stored in metadata", async () => {
    const metadata: SessionMetadata = {
      ...baseMetadata,
      id: "external-url",
      mode: "browser",
      browser: { runtime: { tabUrl: "https://evil.example.com/c/pwned" } },
    };

    expect(resolveBrowserResumeConversationUrl(metadata)).toBeNull();

    const store = { readSession: vi.fn(async () => metadata) };
    await expect(resolveBrowserFollowupReference("external-url", store)).rejects.toThrow(
      /does not contain a recoverable provider conversation URL/s,
    );
  });

  test("rejects a project-shell URL that has no conversation id", async () => {
    const metadata: SessionMetadata = {
      ...baseMetadata,
      id: "project-shell",
      mode: "browser",
      browser: {
        config: { url: "https://chatgpt.com/g/g-p-abc123/project" },
        runtime: { tabUrl: "https://chatgpt.com/g/g-p-abc123/project" },
      },
    };

    expect(resolveBrowserResumeConversationUrl(metadata)).toBeNull();

    const store = { readSession: vi.fn(async () => metadata) };
    await expect(resolveBrowserFollowupReference("project-shell", store)).rejects.toThrow(
      /does not contain a recoverable provider conversation URL/s,
    );
  });

  test("rejects a conversationId fallback when the base URL is not ChatGPT", () => {
    const metadata: SessionMetadata = {
      ...baseMetadata,
      mode: "browser",
      browser: {
        config: { url: "https://evil.example.com/" },
        runtime: { conversationId: "abc-123" },
      },
    };

    // conversationId would rebuild against the stored base; the gate must reject a non-ChatGPT host.
    expect(resolveBrowserResumeConversationUrl(metadata)).toBeNull();
  });

  test("rejects insecure or non-default-port conversation URLs", () => {
    for (const tabUrl of [
      "http://chatgpt.com/c/insecure",
      "https://chatgpt.com:444/c/wrong-port",
    ]) {
      const metadata: SessionMetadata = {
        ...baseMetadata,
        mode: "browser",
        browser: { runtime: { tabUrl } },
      };
      expect(resolveBrowserResumeConversationUrl(metadata)).toBeNull();
    }
  });

  test("resolves a Manus conversation URL from runtime metadata", () => {
    const metadata: SessionMetadata = {
      ...baseMetadata,
      mode: "browser",
      model: "manus",
      browser: {
        config: { url: "https://manus.im/" },
        runtime: { tabUrl: "https://manus.im/app/j5Lk2cHyXhhSMcLUHlDmO5" },
      },
    };

    expect(resolveBrowserResumeConversationUrl(metadata)).toBe(
      "https://manus.im/app/j5Lk2cHyXhhSMcLUHlDmO5",
    );
  });

  test("preserves Manus as the model for stored browser follow-up", async () => {
    const metadata: SessionMetadata = {
      ...baseMetadata,
      id: "manus-session",
      mode: "browser",
      model: "manus",
      options: { model: "manus" },
      browser: {
        config: {
          attachRunning: true,
          remoteChrome: { host: "127.0.0.1", port: 9222 },
          url: "https://manus.im/",
        },
        runtime: { tabUrl: "https://manus.im/app/j5Lk2cHyXhhSMcLUHlDmO5" },
      },
    };
    const store = { readSession: vi.fn(async () => metadata) };

    await expect(resolveBrowserFollowupReference("manus-session", store)).resolves.toEqual({
      sessionId: "manus-session",
      resumeConversationUrl: "https://manus.im/app/j5Lk2cHyXhhSMcLUHlDmO5",
      model: "manus",
      browserConfig: {
        attachRunning: true,
        remoteChrome: { host: "127.0.0.1", port: 9222 },
        url: "https://manus.im/",
        browserTabRef: null,
        resumeConversationUrl: "https://manus.im/app/j5Lk2cHyXhhSMcLUHlDmO5",
        researchMode: "off",
        archiveConversations: "never",
      },
    });
  });

  test("rejects a non-Manus host for a Manus session", () => {
    const metadata: SessionMetadata = {
      ...baseMetadata,
      mode: "browser",
      model: "manus",
      browser: { runtime: { tabUrl: "https://evil.example.com/app/not-manus" } },
    };

    expect(resolveBrowserResumeConversationUrl(metadata)).toBeNull();
  });
});
