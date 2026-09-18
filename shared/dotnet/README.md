# Shared .NET plugin-host source

The .NET plugin hosts (`video-composer`, `media-redactor`, `transcript-refiner`) speak the same newline-delimited
JSON protocol to Filer over stdio. That protocol lives here once, and each host compiles it in through
`PluginHost.Shared.props` — source, not an assembly, so every host still publishes to a single NativeAOT
executable that ships alone in its plugin's `bin/`.

| File | Included | What it is |
|---|---|---|
| `StdioJsonRpc.cs` | always | Reads the request, sends nested requests (`ai.complete`), writes the result or error. |
| `HostAiChatClient.cs` | `FilerPluginHostAiClient=true` | An `IChatClient` whose completions are `ai.complete` calls back to Filer — the host never holds a provider key. |
| `WindowsJobObject.cs` | `FilerPluginHostJobObject=true` | Child processes (ffmpeg) die with the host when Filer stops it. |

A host keeps its own result payload records and their `JsonSerializerContext` (`PluginHostJson.cs`) and passes
the context to `StdioJsonRpc`, which uses it under NativeAOT, where reflection-based serialization is off.

After changing a file here, re-publish every host that includes it (see each plugin's README) and run its tests.
