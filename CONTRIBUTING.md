# Contributing to Filer Official Plugins

The authoring guide and the manifest, context and event references live at https://filer-ai.com/developers. This file covers what is specific to contributing to this repository.

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
  "capabilities": ["describe-image"],

  "contributes": {
    "settings": { ... },
    "tools": [ ... ],
    "actions": [ ... ],
    "hooks": { ... },
    "commands": [ ... ],
    "views": [ ... ]
  },

  "permissions": { "fs": { "read": { "parameter": true, "deny": ["**/.env", "**/.env.*"] } } }
}
```

The field-by-field rules for every block above live at https://filer-ai.com/developers/reference/manifest.

## Development

1. Create your plugin in `plugins/your-plugin/`
2. Add manifest and handlers
3. Test by adding this repository — or your fork — as a Plugin Source in Connect
4. Submit a PR

## Code Style

- ES modules (`export default async function`)
- Always check settings before using them
- Handle errors gracefully with `ctx.log.error()`
- Use `ctx.fetch` instead of importing HTTP libraries

## Catalog (filer-plugins.json)

Every plugin needs one entry in the repository-root `filer-plugins.json`. Its `name` and `version` must match the plugin's own manifest, and `source` is the relative folder path (`./plugins/your-plugin`).

## Lint

Run `npm run lint` at the repository root before opening a PR. The one rule specific to this repo is `local/no-silent-catch`: a `catch` block must rethrow, log with `ctx.log`, or otherwise surface the error — it must never swallow it silently.

## More on authoring plugins

[Tools](https://filer-ai.com/developers/guides/tools) · [Actions](https://filer-ai.com/developers/guides/actions) · [Hooks and events](https://filer-ai.com/developers/guides/hooks) · [Settings](https://filer-ai.com/developers/guides/settings) · [Permissions](https://filer-ai.com/developers/guides/permissions) · [Inbound channels](https://filer-ai.com/developers/guides/inbound-channels)
