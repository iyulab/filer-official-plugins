# Transcript Refiner

Fixes what speech-to-text misheard in a WebVTT transcript, with the user's own configured model
(through the host's `ai.complete` — this plugin holds no credentials). The refinement itself is
[`PulsaTranscript.SDK`](https://www.nuget.org/packages/PulsaTranscript.SDK): every segment and timing
is kept, a meaningless segment becomes `[unclear]`, and a correction that changes too much is not
applied but listed as rejected, with the original.

Tool: `refine_transcript(path, outputPath, changesPath, glossaryPath?)`.

## Build

1. Publish the .NET host (Native AOT; needs the MSVC build tools and `vswhere.exe` on `PATH`):

   ```
   dotnet publish src/TranscriptRefiner.PluginHost -c Release -r win-x64 --self-contained -p:PublishAot=true -o bin
   ```

2. Tests: `dotnet test src/TranscriptRefiner.PluginHost.Tests`.
