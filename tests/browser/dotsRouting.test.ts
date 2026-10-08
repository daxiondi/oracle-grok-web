import { beforeEach, describe, expect, it, vi } from "vitest";

const { executeDots } = vi.hoisted(() => ({ executeDots: vi.fn() }));
vi.mock("../../src/dots-web/index.js", () => ({
  createDotsWebExecutor: () => executeDots,
}));

import { runBrowserMode } from "../../src/browser/index.js";

const dotsUrl = "https://chatgpt.com/dots/123e4567-e89b-12d3-a456-426614174000";

describe("Dots browser dispatch", () => {
  beforeEach(() => executeDots.mockReset());

  it.each(["chatgptUrl", "url", "resumeConversationUrl"])(
    "routes %s directly to the Dots executor without normal ChatGPT automation",
    async (key) => {
      const result = { answerText: "dots reply" };
      executeDots.mockResolvedValue(result);
      const options = { prompt: "hello", config: { [key]: dotsUrl } };
      expect(await runBrowserMode(options)).toBe(result);
      expect(executeDots).toHaveBeenCalledWith(options);
    },
  );

  it("gives the explicit resume URL precedence over the configured base", async () => {
    const resumed = dotsUrl.replace("174000", "174001");
    executeDots.mockResolvedValue({ answerText: "resumed" });
    await runBrowserMode({
      prompt: "follow up",
      config: { chatgptUrl: dotsUrl, resumeConversationUrl: resumed },
    });
    expect(executeDots).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({ resumeConversationUrl: resumed }),
      }),
    );
  });

  it("rejects an empty prompt before opening a Dots tab", async () => {
    await expect(runBrowserMode({ prompt: " ", config: { url: dotsUrl } })).rejects.toThrow(
      "Prompt text is required",
    );
    expect(executeDots).not.toHaveBeenCalled();
  });
});
