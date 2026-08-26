const MANUS_HOSTS = new Set(["manus.im", "www.manus.im"]);

function parseManusUrl(candidate: string | null | undefined): URL | null {
  const trimmed = candidate?.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" || url.port || !MANUS_HOSTS.has(url.hostname.toLowerCase())) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

export function isManusSiteUrl(candidate: string | null | undefined): boolean {
  return parseManusUrl(candidate) !== null;
}

/**
 * Manus conversation links currently use /app/<conversation-id>. Keep this
 * allowlist narrow so a stored browser URL cannot redirect a signed-in tab to
 * an unrelated site or a non-conversation Manus page during follow-up.
 */
export function isRecoverableManusConversationUrl(candidate: string | null | undefined): boolean {
  const url = parseManusUrl(candidate);
  if (!url) return false;
  const segments = url.pathname.split("/").filter(Boolean);
  return segments[0]?.toLowerCase() === "app" && Boolean(segments[1]);
}
