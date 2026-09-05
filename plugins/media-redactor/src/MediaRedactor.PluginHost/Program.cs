using System.Text;
using System.Text.Json;
using MediaRedactor.PluginHost;
using PulsaRedact;

WindowsJobObject.EnsureChildProcessesDieWithThisProcess();

var stdin = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
var stdout = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(encoderShouldEmitUTF8Identifier: false)) { AutoFlush = true };

var rpc = new StdioJsonRpc(stdin, stdout);
var request = rpc.ReadOuterRequest();
var ffmpegBinaryFolder = Path.Combine(AppContext.BaseDirectory, "ffmpeg");

try
{
    switch (request.Method)
    {
        case "redact_region":
        {
            var redactRequest = RedactRegionHandler.ParseRequest(request.Params);
            var redactor = new PulsaRedact.MediaRedactor(ffmpegBinaryFolder);
            var result = await redactor.RedactAsync(redactRequest);
            if (result.Success)
                rpc.WriteFinalResult(request.Id, new RedactRegionResultPayload(true, result.OutputPath));
            else
                rpc.WriteFinalError(request.Id, result.Error!);
            break;
        }
        case "detect_region":
        {
            var path = request.Params["path"].GetString()!;
            var description = request.Params["description"].GetString()!;
            var frameTimestamp = request.Params.TryGetProperty("frameTimestamp", out var ft) ? ft.GetDouble() : 0.0;

            var isVideo = !new[] { ".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif" }
                .Contains(Path.GetExtension(path), StringComparer.OrdinalIgnoreCase);
            var framePath = isVideo
                ? await ExtractFrameAsync(path, frameTimestamp, ffmpegBinaryFolder)
                : path;

            string response;
            try
            {
                var imageBytes = await File.ReadAllBytesAsync(framePath);
                var mimeType = Path.GetExtension(framePath).ToLowerInvariant() switch
                {
                    ".png" => "image/png",
                    ".jpg" or ".jpeg" => "image/jpeg",
                    ".webp" => "image/webp",
                    ".bmp" => "image/bmp",
                    ".gif" => "image/gif",
                    _ => "image/png",
                };
                var dataUrl = $"data:{mimeType};base64,{Convert.ToBase64String(imageBytes)}";

                var (imageWidth, imageHeight) = await DetectRegionHandler.ProbeDimensionsAsync(framePath, ffmpegBinaryFolder);
                var prompt = DetectRegionHandler.BuildPrompt(description, imageWidth, imageHeight);
                response = await rpc.SendRequestAsync("ai.complete", new Dictionary<string, object?>
                {
                    ["prompt"] = prompt,
                    ["imageUrls"] = (IReadOnlyList<string>)[dataUrl],
                });
            }
            finally
            {
                if (isVideo) File.Delete(framePath);
            }

            var (x, y, width, height) = DetectRegionHandler.ParseCoordinates(response);

            // Write the detected coordinates to a sidecar file next to the ORIGINAL source path
            // (not framePath, which is a temp extracted video frame already deleted by this point).
            // Built manually with Utf8JsonWriter — no reflection-based JsonSerializer.Serialize —
            // because this executable is published with PublishAot=true (see StdioJsonRpc.cs).
            using (var sidecarStream = new MemoryStream())
            {
                using (var sidecarWriter = new Utf8JsonWriter(sidecarStream))
                {
                    sidecarWriter.WriteStartObject();
                    sidecarWriter.WriteNumber("x", x);
                    sidecarWriter.WriteNumber("y", y);
                    sidecarWriter.WriteNumber("width", width);
                    sidecarWriter.WriteNumber("height", height);
                    sidecarWriter.WriteEndObject();
                }
                await File.WriteAllBytesAsync($"{path}.detect-region.json", sidecarStream.ToArray());
            }

            rpc.WriteFinalResult(request.Id, new DetectRegionResultPayload(true, x, y, width, height));
            break;
        }
        default:
            rpc.WriteFinalError(request.Id, $"Unknown method '{request.Method}'");
            break;
    }
}
catch (Exception ex)
{
    rpc.WriteFinalError(request.Id, ex.Message);
}

static async Task<string> ExtractFrameAsync(string videoPath, double timestampSeconds, string ffmpegBinaryFolder)
{
    var framePath = Path.Combine(Path.GetTempPath(), $"media-redactor-frame-{Guid.NewGuid():n}.png");
    await FFMpegCore.FFMpegArguments
        .FromFileInput(videoPath, verifyExists: true, opt => opt.WithCustomArgument($"-ss {timestampSeconds.ToString(System.Globalization.CultureInfo.InvariantCulture)}"))
        .OutputToFile(framePath, overwrite: true, opt => opt.WithCustomArgument("-frames:v 1"))
        .ProcessAsynchronously(ffMpegOptions: new FFMpegCore.FFOptions { BinaryFolder = ffmpegBinaryFolder });
    return framePath;
}
