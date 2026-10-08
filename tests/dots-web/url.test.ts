import { describe, expect, it } from "vitest";
import { isDotsConversationUrl, normalizeDotsConversationUrl } from "../../src/dots-web/url.js";

const DOT_ID = "123e4567-e89b-12d3-a456-426614174000";
const DOT_URL = `https://chatgpt.com/dots/${DOT_ID}`;

describe("Dots conversation URL allowlist", () => {
  it("canonicalizes the explicit conversation, trailing slash, hostname and query", () => {
    expect(
      normalizeDotsConversationUrl(
        ` HTTPS://CHATGPT.COM/dots/${DOT_ID.toUpperCase()}/?source=test#latest `,
      ),
    ).toBe(DOT_URL);
    expect(isDotsConversationUrl(DOT_URL)).toBe(true);
  });

  it.each([
    undefined,
    null,
    "",
    "   ",
    "https://chatgpt.com/",
    "https://chatgpt.com/dots/",
    "https://chatgpt.com/dots/not-a-uuid",
    `http://chatgpt.com/dots/${DOT_ID}`,
    `https://www.chatgpt.com/dots/${DOT_ID}`,
    `https://chatgpt.com.evil.test/dots/${DOT_ID}`,
    `https://evil.test/?next=${DOT_URL}`,
    `https://chatgpt.com@evil.test/dots/${DOT_ID}`,
    `https://user@chatgpt.com/dots/${DOT_ID}`,
    `https://user:password@chatgpt.com/dots/${DOT_ID}`,
    `https://chatgpt.com:443/dots/${DOT_ID}`,
    `https://chatgpt.com:9444/dots/${DOT_ID}`,
    `https://chatgpt.com/dots/${DOT_ID}/extra`,
    `https://chatgpt.com/c/${DOT_ID}`,
    `https://chatgpt.com/dots/../dots/${DOT_ID}`,
    `https://chatgpt.com/dots/%2e%2e/dots/${DOT_ID}`,
    `https://chatgpt.com/dots//${DOT_ID}`,
    `https://chatgpt.com/dots\\${DOT_ID}`,
    `https://chatgpt.com/dots/123e4567-e89b-12d3-a456-426614174\n000`,
  ])("rejects untrusted or non-conversation URL %j", (candidate) => {
    expect(normalizeDotsConversationUrl(candidate)).toBeNull();
    expect(isDotsConversationUrl(candidate)).toBe(false);
  });
});
