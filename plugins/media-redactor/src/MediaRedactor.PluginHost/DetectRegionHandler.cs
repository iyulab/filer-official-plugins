using System.Diagnostics;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace MediaRedactor.PluginHost;

internal static partial class DetectRegionHandler
{
    // FFMpegCore's own FFProbe.AnalyseAsync deserializes ffprobe's JSON output via reflection-based
    // System.Text.Json, which throws at runtime under this executable's PublishAot=true (reflection
    // serialization is disabled by default for trimmed/AOT apps) — confirmed by an actual failed
    // call, not assumed. Probing via `ffmpeg -i` and regexing its stderr avoids that path entirely,
    // using only the same GeneratedRegex/JsonDocument style already used elsewhere in this file.
    public static async Task<(int Width, int Height)> ProbeDimensionsAsync(
        string path, string ffmpegBinaryFolder, CancellationToken cancellationToken = default)
    {
        var psi = new ProcessStartInfo(Path.Combine(ffmpegBinaryFolder, "ffmpeg.exe"))
        {
            RedirectStandardError = true,
            RedirectStandardOutput = true,
            UseShellExecute = false,
        };
        psi.ArgumentList.Add("-i");
        psi.ArgumentList.Add(path);

        using var process = Process.Start(psi)
            ?? throw new InvalidOperationException("Failed to start ffmpeg to probe image dimensions.");
        var stderrTask = process.StandardError.ReadToEndAsync(cancellationToken);
        process.StandardOutput.Close();
        var stderr = await stderrTask;
        await process.WaitForExitAsync(cancellationToken);

        var match = ResolutionRegex().Match(stderr);
        if (!match.Success)
            throw new InvalidOperationException(
                $"Could not determine image dimensions for '{path}' from ffmpeg output.");
        return (int.Parse(match.Groups[1].Value), int.Parse(match.Groups[2].Value));
    }

    [GeneratedRegex(@"Video:.*?(\d+)x(\d+)")]
    private static partial Regex ResolutionRegex();

    // A vision model commonly resizes the image internally before reasoning about it, so a bare
    // "pixel coordinates" request without stating the actual source resolution gets an answer in
    // whatever coordinate space the model happens to be reasoning in internally — silently wrong
    // for any image that isn't already at that internal size. Stating the real width/height and
    // anchoring the request to it is the standard mitigation for vision-model spatial grounding.
    public static string BuildPrompt(string description, int imageWidth, int imageHeight) =>
        $$"""
        This image is exactly {{imageWidth}} pixels wide and {{imageHeight}} pixels tall.

        Find the pixel region matching this description: "{{description}}"

        Respond with ONLY a JSON object with the region's bounding box, using pixel coordinates in
        that exact {{imageWidth}}x{{imageHeight}} space (x+width must not exceed {{imageWidth}},
        y+height must not exceed {{imageHeight}}), in this exact shape:
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
