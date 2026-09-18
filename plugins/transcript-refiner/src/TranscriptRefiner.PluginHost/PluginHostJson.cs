using System.Text.Json;
using System.Text.Json.Serialization;
using Filer.PluginHost;

namespace TranscriptRefiner.PluginHost;

// This host's result payloads and their source-generated context. The stdio protocol itself is shared
// source (shared/dotnet/StdioJsonRpc.cs); the context is passed to it so NativeAOT can serialize these.
internal sealed record RefinedChange(
    [property: JsonPropertyName("cue")] int Cue,
    [property: JsonPropertyName("start")] string Start,
    [property: JsonPropertyName("original")] string Original,
    [property: JsonPropertyName("refined")] string Refined,
    [property: JsonPropertyName("kind")] string Kind);

internal sealed record RefineChangesFile(
    [property: JsonPropertyName("source")] string Source,
    [property: JsonPropertyName("cues")] int Cues,
    [property: JsonPropertyName("applied")] IReadOnlyList<RefinedChange> Applied,
    [property: JsonPropertyName("rejected")] IReadOnlyList<RefinedChange> Rejected);

internal sealed record RefineTranscriptResultPayload(
    [property: JsonPropertyName("success")] bool Success,
    [property: JsonPropertyName("outputPath")] string OutputPath,
    [property: JsonPropertyName("changesPath")] string ChangesPath,
    [property: JsonPropertyName("cues")] int Cues,
    [property: JsonPropertyName("applied")] int Applied,
    [property: JsonPropertyName("rejected")] int Rejected,
    [property: JsonPropertyName("unclear")] int Unclear);

[JsonSerializable(typeof(RefineTranscriptResultPayload))]
[JsonSerializable(typeof(RefineChangesFile))]
internal sealed partial class PluginHostJsonContext : JsonSerializerContext
{
}

internal static class PluginHostJson
{
    /// <summary>
    /// The changes file is for a person to read, so it is indented and keeps non-ASCII text as written (a Korean
    /// transcript's corrections would otherwise be escaped). Same resolver rule as the result channel.
    /// </summary>
    internal static readonly JsonSerializerOptions ChangesFileOptions = new()
    {
        WriteIndented = true,
        Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        TypeInfoResolver = StdioJsonRpc.ResolverFor(PluginHostJsonContext.Default)
    };
}
