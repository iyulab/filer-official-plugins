using System.Text;
using PulsaVideoCompose;
using VideoComposer.PluginHost;

// Must run before ffmpeg can ever be spawned (compose_video below): joins this process to a
// Windows Job Object so a future timeout-kill of this process (the host can only TerminateProcess
// it, never signal it — see WindowsJobObject's own doc comment) takes ffmpeg down with it instead
// of orphaning it.
WindowsJobObject.EnsureChildProcessesDieWithThisProcess();

// Console I/O is pinned to explicit UTF-8, independent of the host process's own console code
// page — the wire protocol is UTF-8 regardless of what code page a real attached console (if any)
// would otherwise select.
var stdin = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
var stdout = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(encoderShouldEmitUTF8Identifier: false)) { AutoFlush = true };

var rpc = new StdioJsonRpc(stdin, stdout);
var request = rpc.ReadOuterRequest();
var ffmpegBinaryFolder = Path.Combine(AppContext.BaseDirectory, "ffmpeg");

try
{
    switch (request.Method)
    {
        case "compose_video":
        {
            var composer = new FfmpegVideoComposer(ffmpegBinaryFolder);
            var imagePaths = request.Params.GetProperty("imagePaths").EnumerateArray().Select(e => e.GetString()!).ToList();
            var captions = request.Params.GetProperty("captions").EnumerateArray().Select(e => e.GetString()!).ToList();
            var sceneDurationSeconds = request.Params.GetProperty("sceneDurationSeconds").GetDouble();
            var outputPath = request.Params.GetProperty("outputPath").GetString()!;
            var aspectRatio = request.Params.TryGetProperty("aspectRatio", out var aspectRatioProp)
                ? aspectRatioProp.GetString()!
                : "16:9";

            var result = await composer.ComposeAsync(new ComposeVideoRequest(imagePaths, captions, sceneDurationSeconds, outputPath, aspectRatio));
            if (result.Success)
                rpc.WriteFinalResult(request.Id, new ComposeVideoResultPayload(true, result.OutputPath, result.SrtPath));
            else
                rpc.WriteFinalError(request.Id, result.Error!);
            break;
        }
        case "draft_captions":
        {
            var imagePaths = request.Params.GetProperty("imagePaths").EnumerateArray().Select(e => e.GetString()!).ToList();
            var introText = request.Params.GetProperty("introText").GetString()!;

            var chatClient = new HostAiChatClient(rpc);
            var captions = await CaptionDrafter.DraftAsync(chatClient, new DraftCaptionsRequest(imagePaths, introText));
            rpc.WriteFinalResult(request.Id, new DraftCaptionsResultPayload(true, captions));
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
