# Manus Web Support

Oracle can use the Manus website as a browser provider, in the same style as the Grok web path. It reuses an already-running Chrome profile, opens a dedicated `manus.im` tab, submits the prompt through the page DOM, and captures the completed assistant response.

## Usage

```bash
oracle --engine browser \
  --model manus \
  --browser-attach-running \
  --remote-chrome 127.0.0.1:9222 \
  -p "Review this repository and identify the highest-risk bug"
```

The Chrome profile must already be signed in to Manus. `--remote-chrome` can be omitted when `--browser-attach-running` can discover the local DevTools endpoint. Manus currently uses local attached-browser modes; `oracle serve --remote-host` is not supported by this provider.

## Files and long context

Manus web runs accept the same `--file` inputs and `--browser-attachments auto|never|always` policy as other browser runs:

- Small text inputs are pasted into the composer inline (the current default budget is about 60,000 characters).
- Larger text bundles, binary files, and archives are uploaded through Manus's local-file control.
- Use `--browser-attachments always` to force uploads, or `--browser-inline-files` to require inline text.

This is a delivery policy, not a claim about Manus's maximum context window. The exact Manus web token limit depends on the account and current website implementation and has not been validated by Oracle's live smoke tests. For a large repository, keep `auto` or explicitly upload a generated bundle rather than assuming that a very large pasted prompt will be accepted.

## Follow-ups and recovery

Repeat `--browser-follow-up` to continue in the same Manus tab during one run. Saved browser sessions retain the conversation URL for `oracle restart <session-id>` and `--followup <session-id>` recovery.

The provider reports clear errors for missing sign-in, browser verification challenges, missing composer controls, upload timeouts, and response timeouts. It does not expose or estimate Manus's server-side token accounting; Oracle only reports a local character-based output estimate for session consistency.
