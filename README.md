# OpenClaw Telex

An [OpenClaw](https://github.com/openclaw/openclaw) channel plugin for **Voyager Telex** - the messaging product inside Voyager. It lets an OpenClaw agent receive and reply to Telex direct chats and channels through the Telex OpenAPI, using a Telex **bot** API key.

The channel id inside OpenClaw is `telex`.

## Install

```bash
openclaw plugins add openclaw-telex
```

Then run setup:

```bash
openclaw configure
```

The wizard asks for the bot API key, the Voyager base URL, and DM/channel policies, and verifies the connection.

## Get a bot API key

1. Open Voyager Telex and register a bot (Settings -> Bots -> Register).
2. Copy the one-time **plaintext API key** shown on registration.
3. The base URL is your Voyager host (default `https://voyager.ingarena.net`).

The key authenticates as the bot identity; every message the plugin sends is attributed to that bot.

## Configuration

Config lives under `channels.telex`:

```jsonc
{
  "channels": {
    "telex": {
      "enabled": true,
      "apiKey": "<plaintext bot api key>",
      "baseUrl": "https://voyager.ingarena.net",
      "botId": "0a1b2c3d4e5f6071",        // optional override; identity is resolved via get-identity at connect

      "dmPolicy": "allowlist",             // open | allowlist | pairing
      "allowFrom": ["alice@company.com", "0a1b2c3d4e5f6071"],

      "groupPolicy": "disabled",           // disabled | allowlist | open
      "groupAllowFrom": ["<channel conversation id>"],
      "groupSenderAllowFrom": ["alice@company.com"],
      "groupRequireMention": true,         // in channels, only respond when @-mentioned

      "processingIndicator": "activity"    // activity | off
    }
  }
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `apiKey` | - | Telex bot API key (`x-api-key`). Required. |
| `baseUrl` | `https://voyager.ingarena.net` | Voyager API host. |
| `botId` | - | The bot's identity id (16-char hex). Optional override; the plugin resolves it via `get-identity` at connect. |
| `dmPolicy` | `allowlist` | Who may DM the bot. `open` requires `allowFrom` to include `"*"`. |
| `allowFrom` | - | Identity ids or emails allowed to DM (and pairing-approved ids). |
| `groupPolicy` | `disabled` | Channel participation. `allowlist` restricts to `groupAllowFrom`. |
| `groupAllowFrom` | - | Allowed channel (conversation) ids when `groupPolicy="allowlist"`. |
| `groupSenderAllowFrom` | - | If set, only these senders trigger the bot in channels. |
| `groupRequireMention` | `true` | In channels, respond only when the bot is @-mentioned. |
| `processingIndicator` | `activity` | Show an activity status while the agent works; `off` to disable. |

Multiple bots are supported via `channels.telex.accounts.<id>` overrides, the same way other OpenClaw channels do.

## How it works

- **Inbound** opens one long-lived server-streaming connection to `GET /voyager/v1/openapi/telex/subscribe`. This single stream carries new messages for every conversation the bot belongs to; whether the bot was mentioned is derived client-side from each message's `mention_ids`/`mention_all`. The stream is forward-only (it does not replay history); on reconnect the plugin backfills the gap per conversation with `list-messages(after_seq)`.
- **Outbound** posts text blocks to `POST /voyager/v1/openapi/telex/send-message`, chunked for readability, with a `working` activity indicator (`set-activity`) while the agent runs.
- **Outbound mentions** are inline tokens in the text: `[@](mention:<identity_id>)` or `[@all](mention:all)`; the server derives the targets from them and fills in the target's real display name. The plugin teaches the agent this syntax via a message-tool prompt hint, exposes sender ids in inbound envelopes, and puts a ready-to-paste `mention` token in `telex` tool identity results.
- **Media** flows through the OpenAPI file endpoints. Inbound image/file blocks are auto-downloaded (`GET /openapi/telex/download-file`, unauthenticated by design - the encrypted file id is the capability) and handed to the agent as attachments so it can see images; media in history/backfill context is passed as public download links instead. Outbound attachments are uploaded (`POST /openapi/telex/upload-file`, ≤20 MB) and sent as a media block.
- **Direct chats** (Telex `chat`) are answered subject to `dmPolicy`. **Channels** (Telex `channel`) are answered subject to `groupPolicy` and, by default, only when the bot is mentioned.
- **Self-echo suppression**: the subscribe stream fans the bot's own messages back to it, so the plugin drops messages sent by its own identity (resolved via `get-identity` at connect; `botId` overrides, and send responses confirm it).

## Agent tool

When enabled, the plugin registers a `telex` tool so the agent can inspect Telex and manage channels:

- `search_identities` - fuzzy find users/bots by name or email
- `get_identities` - exact resolve by id and/or email
- `list_conversations` - chats and channels (paginated)
- `get_conversation_info` - a conversation's details
- `create_channel` - create a channel
- `list_members` - members of a conversation
- `add_members` - add members to a channel
- `get_conversation_messages` - messages in a conversation (chronological)

Each action can be disabled under `channels.telex.tools`.

## Limitations

- **No threads.** The Telex OpenAPI send surface is per-conversation; each conversation maps to one agent session.
- **Media is 20 MB max** (the server upload cap), and inbound media is auto-downloaded on every message it appears in.
- Sync state is in-memory except the server-persisted read cursor: a restart resumes each conversation from its `read_seq` and repairs forward through windowed `list-messages` reads, so messages that arrived while down are backfilled.

## Publishing

For npm releases, `prepublishOnly` rebuilds `dist/` automatically:

```bash
npm version patch
npm publish --access public
```

For beta builds, publish with the `beta` dist-tag:

```bash
npm publish --tag beta
```

For ClawHub releases, build first because `prepublishOnly` does not run:

```bash
pnpm build
clawhub package publish .
```

## License

Apache-2.0
