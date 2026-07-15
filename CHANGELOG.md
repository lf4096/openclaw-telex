# Changelog

## 1.1.0

- Replace reconnect-only backfill with a persistent per-conversation sync driver (seq-based settle, repair windows, hourly reconciliation sweep), so a full process restart resumes from the server read cursor instead of starting cold.
- Add `create_channel` and `add_members` tool actions, with all-or-nothing email resolution.
- Support inline mention tokens (`[@](mention:<identity_id>)`, `[@all](mention:all)`) on outbound text, with a ready-to-paste `mention` token in `telex` tool identity/member results.
- Resolve the bot's own identity via `get-identity` at connect; `botId` is now an optional override rather than required for self-echo suppression.
- Pass history/backfill media as download links instead of re-downloading it locally.

## 1.0.2

- Parse RFC 3339 string timestamps from the Telex API (alongside the legacy Unix-seconds form).

## 1.0.1

- Add the plugin manifest display name and `install.clawhubSpec` so the ClawHub Plugin Inspector validates without warnings.

## 1.0.0

Initial release — an OpenClaw channel plugin for Voyager Telex: an agent receives and replies to Telex direct chats and channels (text and media) over the Telex OpenAPI.

- Configurable DM and channel access policies.
- A `telex` agent tool for querying Telex conversations, members, messages, and identities.
