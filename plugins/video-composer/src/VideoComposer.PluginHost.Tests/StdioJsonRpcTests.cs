using System.Text.Json;
using FluentAssertions;
using VideoComposer.PluginHost;
using Xunit;

namespace VideoComposer.PluginHost.Tests;

public class StdioJsonRpcTests
{
    [Fact]
    public async Task SendRequestAsync_WritesOneLineAndParsesTheMatchingResponse()
    {
        var input = new StringReader("{\"id\":\"nested-1\",\"result\":\"a drafted caption\"}\n");
        using var output = new StringWriter();
        var rpc = new StdioJsonRpc(input, output);

        var result = await rpc.SendRequestAsync("ai.complete", new Dictionary<string, object?> { ["prompt"] = "hi" });

        var written = JsonDocument.Parse(output.ToString().TrimEnd('\n'));
        written.RootElement.GetProperty("method").GetString().Should().Be("ai.complete");
        written.RootElement.GetProperty("params").GetProperty("prompt").GetString().Should().Be("hi");
        result.Should().Be("a drafted caption");
    }

    [Fact]
    public async Task SendRequestAsync_ThrowsOnAnErrorResponse()
    {
        var input = new StringReader("{\"id\":\"nested-1\",\"error\":\"no model configured\"}\n");
        using var output = new StringWriter();
        var rpc = new StdioJsonRpc(input, output);

        var act = async () => await rpc.SendRequestAsync("ai.complete", new Dictionary<string, object?>());

        await act.Should().ThrowAsync<InvalidOperationException>().WithMessage("no model configured");
    }

    [Fact]
    public void ReadOuterRequest_ParsesTheInitialToolCall()
    {
        var input = new StringReader("{\"id\":\"outer-1\",\"method\":\"compose_video\",\"params\":{\"outputPath\":\"out.mp4\"}}\n");
        var rpc = new StdioJsonRpc(input, new StringWriter());

        var request = rpc.ReadOuterRequest();

        request.Id.Should().Be("outer-1");
        request.Method.Should().Be("compose_video");
        request.Params["outputPath"].GetString().Should().Be("out.mp4");
    }

    [Fact]
    public void WriteFinalResult_WritesAResponseLineWithNoMethod()
    {
        using var output = new StringWriter();
        var rpc = new StdioJsonRpc(new StringReader(""), output);

        rpc.WriteFinalResult("outer-1", new { success = true, outputPath = "out.mp4" });

        var written = JsonDocument.Parse(output.ToString().TrimEnd('\n'));
        written.RootElement.GetProperty("id").GetString().Should().Be("outer-1");
        written.RootElement.GetProperty("result").GetProperty("success").GetBoolean().Should().BeTrue();
        written.RootElement.TryGetProperty("method", out _).Should().BeFalse();
    }

    [Fact]
    public void WriteFinalError_WritesAnErrorResponseLine()
    {
        using var output = new StringWriter();
        var rpc = new StdioJsonRpc(new StringReader(""), output);

        rpc.WriteFinalError("outer-1", "boom");

        var written = JsonDocument.Parse(output.ToString().TrimEnd('\n'));
        written.RootElement.GetProperty("id").GetString().Should().Be("outer-1");
        written.RootElement.GetProperty("error").GetString().Should().Be("boom");
    }
}
