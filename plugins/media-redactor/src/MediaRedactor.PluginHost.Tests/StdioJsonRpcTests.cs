using System.Text.Json;
using FluentAssertions;
using MediaRedactor.PluginHost;
using Xunit;

namespace MediaRedactor.PluginHost.Tests;

public class StdioJsonRpcTests
{
    [Fact]
    public async Task SendRequestAsync_WritesOneLineAndParsesTheMatchingResponse()
    {
        var input = new StringReader("{\"id\":\"nested-1\",\"result\":\"the region is at (10,20,100,50)\"}\n");
        using var output = new StringWriter();
        var rpc = new StdioJsonRpc(input, output);

        var result = await rpc.SendRequestAsync("ai.complete", new Dictionary<string, object?> { ["prompt"] = "hi" });

        result.Should().Be("the region is at (10,20,100,50)");
    }

    [Fact]
    public async Task SendRequestAsync_WithImageUrlsListParam_WritesItAsAJsonArray()
    {
        var input = new StringReader("{\"id\":\"nested-1\",\"result\":\"ok\"}\n");
        using var output = new StringWriter();
        var rpc = new StdioJsonRpc(input, output);

        await rpc.SendRequestAsync("ai.complete", new Dictionary<string, object?>
        {
            ["prompt"] = "find it",
            ["imageUrls"] = (IReadOnlyList<string>)["data:image/png;base64,AAAA"],
        });

        var written = JsonDocument.Parse(output.ToString().TrimEnd('\n'));
        var imageUrls = written.RootElement.GetProperty("params").GetProperty("imageUrls");
        imageUrls.ValueKind.Should().Be(JsonValueKind.Array);
        imageUrls[0].GetString().Should().Be("data:image/png;base64,AAAA");
    }

    [Fact]
    public async Task SendRequestAsync_UnsupportedParamType_Throws()
    {
        using var output = new StringWriter();
        var rpc = new StdioJsonRpc(new StringReader(""), output);

        var act = async () => await rpc.SendRequestAsync("ai.complete", new Dictionary<string, object?> { ["x"] = 42 });

        await act.Should().ThrowAsync<NotSupportedException>();
    }
}
