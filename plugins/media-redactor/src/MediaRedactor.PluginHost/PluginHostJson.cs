using System.Text.Json.Serialization;

namespace MediaRedactor.PluginHost;

// This host's result payloads and their source-generated context. The stdio protocol itself is shared
// source (shared/dotnet/StdioJsonRpc.cs); the context is passed to it so NativeAOT can serialize these.
internal sealed record RedactRegionResultPayload(
    [property: JsonPropertyName("success")] bool Success,
    [property: JsonPropertyName("outputPath")] string? OutputPath);

internal sealed record DetectRegionResultPayload(
    [property: JsonPropertyName("success")] bool Success,
    [property: JsonPropertyName("x")] int X,
    [property: JsonPropertyName("y")] int Y,
    [property: JsonPropertyName("width")] int Width,
    [property: JsonPropertyName("height")] int Height);

[JsonSerializable(typeof(RedactRegionResultPayload))]
[JsonSerializable(typeof(DetectRegionResultPayload))]
internal sealed partial class PluginHostJsonContext : JsonSerializerContext
{
}
