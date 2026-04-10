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

Hooks respond to system events:

```json
"hooks": {
  "onAgentExecutionCompleted": "./hooks/on-complete.js",
  "onFileChanged": "./hooks/on-file-changed.js",
  "onAppReady": "./hooks/on-ready.js"
}
```

Available events:
- `onAppReady` — App started
- `onFileChanged` — Watched files changed
- `onAgentExecutionCompleted` — Agent finished
- `onAgentExecutionFailed` — Agent failed
- `onSessionCreated` — Chat session created
- `onSessionEnded` — Chat session ended
- `onVaultChanged` — Vault content changed
- `onSettingsChanged` — Settings changed
- `onPluginInstalled` — Plugin installed
- `onPluginUninstalled` — Plugin uninstalled

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
