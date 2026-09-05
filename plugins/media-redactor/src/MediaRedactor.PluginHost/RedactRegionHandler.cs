using PulsaRedact;

namespace MediaRedactor.PluginHost;

internal static class RedactRegionHandler
{
    public static RedactRequest ParseRequest(JsonParams p) => new(
        InputPath: p["path"].GetString()!,
        OutputPath: p["outputPath"].GetString()!,
        X: p["x"].GetInt32(),
        Y: p["y"].GetInt32(),
        Width: p["width"].GetInt32(),
        Height: p["height"].GetInt32(),
        StartTime: p.TryGetProperty("startTime", out var s) ? s.GetDouble() : null,
        EndTime: p.TryGetProperty("endTime", out var e) ? e.GetDouble() : null);
}
