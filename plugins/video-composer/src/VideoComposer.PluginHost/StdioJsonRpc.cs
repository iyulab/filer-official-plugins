using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.Json.Serialization.Metadata;

namespace VideoComposer.PluginHost;

/// <summary>
/// Thin wrapper over a request's `params` object. JsonElement only indexes by int, so this adds a
/// string indexer for call sites that look up a single named property, alongside the existing
/// JsonElement.GetProperty-style access other call sites already use.
/// </summary>
public readonly struct JsonParams(JsonElement element)
{
    public JsonElement this[string propertyName] => element.GetProperty(propertyName);
    public JsonElement GetProperty(string propertyName) => element.GetProperty(propertyName);
    public bool TryGetProperty(string propertyName, out JsonElement value) => element.TryGetProperty(propertyName, out value);
}

public sealed record OuterRequest(string Id, string Method, JsonParams Params);

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

/// <summary>
/// The JSON-RPC-shaped stdio protocol between the host and this process: newline-delimited JSON, a
/// `method`-bearing line is a request (either direction), a `result`/`error`-bearing line with no
/// `method` is the response to a previously-sent request. This adapter is the ONLY place in this
/// plugin that speaks it.
///
/// NativeAOT disables reflection-based System.Text.Json serialization by default
/// (PublishAot=true sets JsonSerializerIsReflectionEnabledByDefault=false). A plain
/// JsonSerializer.Serialize(anonymousObject) call builds without error under that setting
/// (the trimmer-analysis warnings, IL2026/IL3050, are warnings, not build errors) but throws at
/// runtime once the AOT-published executable actually runs. The two result payload types below are
/// therefore serialized through a source-generated JsonSerializerContext when reflection-based
/// serialization is unavailable, and through the ordinary reflection-based resolver otherwise (so
/// `dotnet test`, which always runs with reflection enabled, still exercises normal
/// System.Text.Json behavior).
/// </summary>
public sealed class StdioJsonRpc(TextReader input, TextWriter output)
{
    private static readonly JsonSerializerOptions ResultOptions = new()
    {
        TypeInfoResolver = JsonSerializer.IsReflectionEnabledByDefault
            ? new DefaultJsonTypeInfoResolver()
            : PluginHostJsonContext.Default
    };

    public OuterRequest ReadOuterRequest()
    {
        var line = input.ReadLine() ?? throw new InvalidOperationException("No request line on stdin.");
        var doc = JsonDocument.Parse(line);
        var root = doc.RootElement;
        return new OuterRequest(
            root.GetProperty("id").GetString()!,
            root.GetProperty("method").GetString()!,
            new JsonParams(root.TryGetProperty("params", out var p) ? p : default));
    }

    public async Task<string> SendRequestAsync(string method, IReadOnlyDictionary<string, object?> parameters)
    {
        var id = Guid.NewGuid().ToString("n");

        using (var stream = new MemoryStream())
        {
            using (var writer = new Utf8JsonWriter(stream))
            {
                writer.WriteStartObject();
                writer.WriteString("id", id);
                writer.WriteString("method", method);
                writer.WritePropertyName("params");
                writer.WriteStartObject();
                foreach (var (key, value) in parameters)
                {
                    switch (value)
                    {
                        case null:
                            writer.WriteNull(key);
                            break;
                        case string s:
                            writer.WriteString(key, s);
                            break;
                        default:
                            throw new NotSupportedException(
                                $"Nested request param '{key}' has unsupported type '{value.GetType()}' — only string values are supported over this channel.");
                    }
                }
                writer.WriteEndObject();
                writer.WriteEndObject();
            }
            await output.WriteLineAsync(Encoding.UTF8.GetString(stream.ToArray())).ConfigureAwait(false);
        }
        await output.FlushAsync().ConfigureAwait(false);

        var line = await input.ReadLineAsync().ConfigureAwait(false)
            ?? throw new InvalidOperationException($"No response for nested request '{method}'.");
        var doc = JsonDocument.Parse(line);
        var root = doc.RootElement;
        if (root.TryGetProperty("error", out var errorProp))
            throw new InvalidOperationException(errorProp.GetString());
        return root.GetProperty("result").GetString() ?? string.Empty;
    }

    public void WriteFinalResult(string id, object result)
    {
        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream))
        {
            writer.WriteStartObject();
            writer.WriteString("id", id);
            writer.WritePropertyName("result");
            JsonSerializer.Serialize(writer, result, result.GetType(), ResultOptions);
            writer.WriteEndObject();
        }
        output.WriteLine(Encoding.UTF8.GetString(stream.ToArray()));
    }

    public void WriteFinalError(string id, string error)
    {
        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream))
        {
            writer.WriteStartObject();
            writer.WriteString("id", id);
            writer.WriteString("error", error);
            writer.WriteEndObject();
        }
        output.WriteLine(Encoding.UTF8.GetString(stream.ToArray()));
    }
}
