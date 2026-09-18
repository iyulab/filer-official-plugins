using System.Text;
using TranscriptRefiner.PluginHost;

// Console I/O is pinned to explicit UTF-8, independent of the host process's own console code page — the wire
// protocol is UTF-8 regardless of what code page a real attached console would otherwise select.
var stdin = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
var stdout = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(encoderShouldEmitUTF8Identifier: false)) { AutoFlush = true };

var rpc = new StdioJsonRpc(stdin, stdout);
var request = rpc.ReadOuterRequest();

try
{
    switch (request.Method)
    {
        case "refine_transcript":
        {
            var path = request.Params.GetProperty("path").GetString()!;
            var outputPath = request.Params.GetProperty("outputPath").GetString()!;
            var changesPath = request.Params.GetProperty("changesPath").GetString()!;
            var glossaryPath = request.Params.TryGetProperty("glossaryPath", out var g) && g.GetString() is { Length: > 0 } gp ? gp : null;

            var result = await RefineCommand.RunAsync(new HostAiChatClient(rpc), path, outputPath, changesPath, glossaryPath);
            rpc.WriteFinalResult(request.Id, result);
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
