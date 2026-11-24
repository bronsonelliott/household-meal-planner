# Captured signal-cli 0.14.8 JSON-RPC traffic

Captured 2026-09-30 from the bot's live account in the "Test group" group (`jsonRpc --receive-mode manual`,
attachments not downloaded), then scrubbed: account IDs, the group ID, the bot's number, names, and attachment
file names are replaced with fixed fakes. Reuse these IDs in tests:

| Fake | Stands for |
|---|---|
| `aaaaaaaa-0000-4000-8000-000000000001` / "Adult One" | an allowlisted adult (number hidden, so `sourceNumber` is null) |
| `bbbbbbbb-0000-4000-8000-0000000000b0` | the bot's account ID as group members see it |
| `bbbbbbbb-0000-4000-8000-0000000000b1` | the ID `getUserStatus` returns for the bot's own number (differs from the group-member ID; do not compare them) |
| `VEVTVC1HUk9VUC1GSVhUVVJFLTAwMDAwMDAwMDAwMDA=` | the "Test group" group ID |
| `+15555550123` | the bot's number |

Notes from the capture:
- Receive notifications arrive wrapped as `params.subscription` + `params.result.envelope` in manual mode.
- A reaction is a `dataMessage` with `reaction` and no text; an edit is an `editMessage` envelope; a mention carries
  a placeholder character in `message` plus a `mentions` array.
- `send` returns `timestamp` plus one `results` entry per recipient with a `type` (`SUCCESS`, or a failure type:
  `NETWORK_FAILURE`, `UNREGISTERED_FAILURE`, `IDENTITY_FAILURE`, `RATE_LIMIT_FAILURE`, `INVALID_PRE_KEY_FAILURE`;
  rate-limit results also carry `token` and `retryAfterSeconds`). Failure shapes come from the 0.14.8 jar, not a capture.
- `getUserStatus` reaches Signal's server; an unregistered number returns `isRegistered: false`.
- No typing or sync envelopes arrived during this capture.
