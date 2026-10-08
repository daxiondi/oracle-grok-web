const DOTS_PATH = /^\/dots\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i;

/** Canonicalize only explicit, trusted Dot conversation URLs. */
export function normalizeDotsConversationUrl(candidate: string | null | undefined): string | null {
  const trimmed = candidate?.trim();
  // Check the literal authority too: URL.port normalizes an explicit :443 away.
  const authorityAndPath = trimmed?.match(/^https:\/\/chatgpt\.com(\/[^?#]*)(?:[?#]|$)/i);
  if (!trimmed || !authorityAndPath || /[\\\u0000-\u0020\u007f]/.test(trimmed)) {
    return null;
  }
  try {
    const url = new URL(trimmed);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "chatgpt.com" ||
      url.username ||
      url.password ||
      url.port
    ) {
      return null;
    }
    const match = DOTS_PATH.exec(authorityAndPath[1]);
    return match ? `https://chatgpt.com/dots/${match[1].toLowerCase()}` : null;
  } catch {
    return null;
  }
}

export function isDotsConversationUrl(candidate: string | null | undefined): boolean {
  return normalizeDotsConversationUrl(candidate) !== null;
}
