# Changelog

## 1.0.2

- Parse RFC 3339 string timestamps from the Telex API (alongside the legacy Unix-seconds form).

## 1.0.1

- Add the plugin manifest display name and `install.clawhubSpec` so the ClawHub Plugin Inspector validates without warnings.

## 1.0.0

Initial release — an OpenClaw channel plugin for Voyager Telex: an agent receives and replies to Telex direct chats and channels (text and media) over the Telex OpenAPI.

- Configurable DM and channel access policies.
- A `telex` agent tool for querying Telex conversations, members, messages, and identities.
