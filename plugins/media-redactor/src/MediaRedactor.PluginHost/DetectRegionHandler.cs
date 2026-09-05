using System.Text.Json;
using System.Text.RegularExpressions;

namespace MediaRedactor.PluginHost;

internal static partial class DetectRegionHandler
{
    public static string BuildPrompt(string description) =>
        $$"""
        Find the pixel region matching this description: "{{description}}"

        Respond with ONLY a JSON object with the region's bounding box, in this exact shape:
        {"x": <left edge, pixels>, "y": <top edge, pixels>, "width": <pixels>, "height": <pixels>}

        No other text, no markdown formatting, no explanation.
        """;

    public static (int X, int Y, int Width, int Height) ParseCoordinates(string modelResponse)
    {
        var match = JsonObjectRegex().Match(modelResponse);
        if (!match.Success)
            throw new InvalidOperationException(
                $"Could not find a coordinate JSON object in the model's response: {modelResponse}");

        using var doc = JsonDocument.Parse(match.Value);
        var root = doc.RootElement;
        return (
            root.GetProperty("x").GetInt32(),
            root.GetProperty("y").GetInt32(),
            root.GetProperty("width").GetInt32(),
            root.GetProperty("height").GetInt32());
    }

    [GeneratedRegex(@"\{[^{}]*\}")]
    private static partial Regex JsonObjectRegex();
}
