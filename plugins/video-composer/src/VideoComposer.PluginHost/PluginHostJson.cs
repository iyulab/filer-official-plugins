using System.Text.Json.Serialization;

namespace VideoComposer.PluginHost;

// This host's result payloads and their source-generated context. The stdio protocol itself is shared
// source (shared/dotnet/StdioJsonRpc.cs); the context is passed to it so NativeAOT can serialize these.
internal sealed record ComposeVideoResultPayload(
    [property: JsonPropertyName("success")] bool Success,
    [property: JsonPropertyName("outputPath")] string? OutputPath,
    [property: JsonPropertyName("srtPath")] string? SrtPath);

internal sealed record DraftCaptionsResultPayload(
    [property: JsonPropertyName("success")] bool Success,
    [property: JsonPropertyName("captions")] IReadOnlyList<string> Captions);

[JsonSerializable(typeof(ComposeVideoResultPayload))]
[JsonSerializable(typeof(DraftCaptionsResultPayload))]
internal sealed partial class PluginHostJsonContext : JsonSerializerContext
{
}
