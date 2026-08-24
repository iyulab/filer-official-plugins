# Contributing to Filer Official Plugins

## Plugin Structure

Each plugin lives in `plugins/<name>/` with this structure:

```
plugins/my-plugin/
├── filer-plugin.json    # Manifest (required)
├── tools/               # MCP tool handlers
│   └── my-tool.js
├── hooks/               # Event hook handlers
│   └── on-event.js
├── commands/            # UI command handlers
│   └── my-command.js
├── views/               # View definitions (JSON)
│   └── dashboard.json
└── assets/              # Icons, images
    └── icon.svg
```

## Manifest (filer-plugin.json)

```json
{
  "name": "my-plugin",
  "displayName": "My Plugin",
  "version": "0.1.0",
  "description": "What this plugin does",
  "author": { "name": "you", "url": "https://github.com/you" },
  "license": "MIT",
  "runtime": "node",
  "engines": { "filer": ">=0.2.0" },
  "bundled": true,

  "contributes": {
    "settings": { ... },
    "tools": [ ... ],
    "hooks": { ... },
    "commands": [ ... ],
    "views": [ ... ]
  }
}
```

## Plugin Context (ctx)

Every handler receives `(params, ctx)` where ctx provides:

| API | Description |
|-----|-------------|
| `ctx.settings.get(key)` | Read a setting value |
| `ctx.settings.getAll()` | Read all settings for this plugin |
| `ctx.fetch(url, options)` | HTTP fetch (Node.js fetch) |
| `ctx.fs.read(path)` | Read a file |
| `ctx.fs.write(path, data)` | Write a file |
| `ctx.fs.list(dir)` | List directory contents |
| `ctx.toast({ type, message })` | Show a toast notification |
| `ctx.execute(commandId, args?)` | Execute a plugin command |
| `ctx.session.getActive()` | Get active chat session info |
| `ctx.session.sendMessage(id, msg)` | Send a message to a session |
| `ctx.store.get(key)` | Read from persistent KV store |
| `ctx.store.set(key, value)` | Write to persistent KV store |
| `ctx.store.list(prefix?)` | List store keys |
| `ctx.store.delete(key)` | Delete a store key |
| `ctx.viewData.set(key, data)` | Set view data (for UI views) |
| `ctx.viewData.get(key)` | Get view data |
| `ctx.log.info/warn/error(msg)` | Log with plugin prefix |

## Settings

Settings are defined in the manifest under `contributes.settings`:

```json
"settings": {
  "my-plugin.apiKey": {
    "type": "string",
    "title": "API Key",
    "description": "Your API key",
    "secret": true,
    "required": true,
    "order": 1
  }
}
```

Supported types: `string`, `boolean`, `number`
Secret settings are encrypted with Electron safeStorage.

## Tools

Tools are exposed as MCP tools to the AI agent:

```json
"tools": [{
  "name": "my_tool",
  "description": "What this tool does",
  "handler": "./tools/my-tool.js",
  "parameters": {
    "type": "object",
    "properties": {
      "input": { "type": "string", "description": "Input value" }
    },
    "required": ["input"]
  }
}]
```

Handler:
```js
export default async function(params, ctx) {
  const apiKey = await ctx.settings.get('my-plugin.apiKey');
  // ... do work ...
  return { success: true, result: '...' };
}
```

## Hooks

Hooks respond to system events. A handler is called as `(event, ctx)` — `event`'s shape depends on
which event fired (see below); it is passed through unmodified, so check its actual fields rather
than assuming a shape.

```json
"hooks": {
  "onAgentComplete": "./hooks/on-complete.js",
  "onFileChange": "./hooks/on-file-change.js",
  "onAppReady": "./hooks/on-ready.js"
}
```

Available events and their current payload shape (source: `PluginEventType` in
`src/ui/src/main/plugins/plugin-event-bus.ts`, and each event's actual emission call site):

- `onAppReady` — App started. `{}`
- `onSessionStart` — A session (chat panel or working-agent trigger) started. `{ sessionId, channelId }`
- `onSessionEnd` — declared in the type union but **not currently emitted from anywhere** — a handler
  registered for it will never run.
- `onAgentComplete` — A turn/agent execution finished, for both a UI-chat-panel session and a
  host-triggered (file/schedule/inbound) execution. `{ sessionId, channelId, result, duration }` —
  `result` is the turn's final answer text as a **plain string**, or `null` for a UI-chat-panel
  session (that path streams its result to the renderer directly instead of through this event).
  `duration` is milliseconds (`0` for the UI-chat-panel path).
- `onToolCall` — A tool call completed during a turn. `{ toolId, params, result, success }`
- `onFileChange` — A watched file changed; supports an `extensions` hook filter. `{ path }`
- `onFileMemorized` — A file was added to the vault. `{ path }`
- `onActionCreated` — declared in the type union but **not currently emitted from anywhere**.
- `onPluginSettingsChanged` — One of your plugin's own settings changed via the UI.
  `{ key, oldValue, newValue }`
- `onFileChangeNotify` — A working-agent's folder-watch trigger fired (used for messenger-relay
  integrations, not the general file-change hook above).
  `{ agentId, channelId, folderPath, folderDisplayName, changes, summary, isDigest }`
- `onSessionMessage` — Fires alongside `onAgentComplete` (when the session has both a `sessionId` and
  a `channelId`) specifically for plugins that relay a turn's result to an external channel (see
  `telegram/hooks/on-session-message.js`). `{ sessionId, channelId, result? }` — for a host-triggered
  execution, `result` carries the final answer text directly (`typeof event.result === 'string'`); a
  UI-chat-panel session omits `result` entirely, so a handler needs its own lookup (e.g. the
  `/api/sessions/{id}/history` endpoint) in that case.
- `onChannelChanged` — A channel was registered/unregistered for a folder.
  `{ channelId, path, action: 'registered' | 'unregistered' }`
- `onAgentHitlRequest` — A HITL approval request was raised for an agent action.
  `{ agentId, executionId, requestId, action, target, description, channelId }`

**A mistake worth naming explicitly, since three of this repo's own bundled plugins shipped it**:
`result` above is always a plain `string` or `null`, **never** an object — `event.result?.summary`
silently evaluates to `undefined` rather than erroring, so the bug doesn't announce itself. Read
`event.result` directly.

## When Conditions

Commands and context menu items support `when` conditions:

```json
"commands": [{
  "id": "my-command",
  "title": "Do Something",
  "when": "fileSelected && !agentRunning",
  "handler": "./commands/my-command.js"
}]
```

Supported: `fileSelected`, `multiSelected`, `sessionActive`, `agentRunning`, `vaultOpen`, `hasSelection`, `setting:key`, `!`, `&&`, `||`

## Cross-Plugin Invocation

Call other plugins' commands:
```js
await ctx.execute('other-plugin.commandId', { arg: 'value' });
```

## Slash Commands

Users can invoke plugin commands from chat:
```
/my-plugin.my-command some arguments
```

## Inbound Triggers (Channel-Reactive)

Plugins that receive messages from external services (Telegram, Slack, etc.)
forward them to the host via `POST /api/triggers/inbound`:

```js
export default async function startPolling(ctx) {
  // ... receive message from external service ...

  const messageId = `${pluginSlug}-${nativeId}`;

  await ctx.fetch(`${hostUrl}/api/triggers/inbound`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      channel_id: channelId,
      source_plugin: pluginSlug,
      message_id: messageId,
      content: messageText,
    }),
  });
}
```

### message_id Convention

The `message_id` field **must** follow the format `<plugin>-<native_id>`:

| Plugin | Native ID source | Example |
|--------|-----------------|---------|
| telegram | `update.update_id` | `telegram-928374` |
| slack | `event.ts` | `slack-1712345678.001200` |
| discord | `message.id` | `discord-1234567890` |
| email | message `Message-ID` header | `email-abc123@mail.example.com` |

This convention ensures global uniqueness across plugins and enables
deduplication and tracing through the pipeline.

**Reference implementation:** `plugins/telegram/services/polling-service.js`

## Development

1. Create your plugin in `plugins/your-plugin/`
2. Add manifest and handlers
3. Test by installing Filer and adding this repo as a Plugin Source
4. Submit a PR

## Code Style

- ES modules (`export default async function`)
- Always check settings before using them
- Handle errors gracefully with `ctx.log.error()`
- Use `ctx.fetch` instead of importing HTTP libraries
