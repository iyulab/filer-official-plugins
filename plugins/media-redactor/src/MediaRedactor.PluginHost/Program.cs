using System.Text;
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
        default:
            rpc.WriteFinalError(request.Id, $"Unknown method '{request.Method}'");
            break;
    }
}
catch (Exception ex)
{
    rpc.WriteFinalError(request.Id, ex.Message);
}
