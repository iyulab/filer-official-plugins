using System.Text.Json;
using FluentAssertions;
using VideoComposer.PluginHost;
using Xunit;

namespace VideoComposer.PluginHost.Tests;

/// <summary>
/// Exercises the source-generated PluginHostJsonContext directly, bypassing StdioJsonRpc's
/// dual-mode resolver (which always picks the reflection-based resolver under `dotnet test`,
/// since reflection-based serialization is enabled there). This is the path that only actually
/// runs once PublishAot disables reflection-based serialization, and it's the path a regression
/// in the source-generated metadata would otherwise go untested.
/// </summary>
public class PluginHostJsonContextTests
{
    [Fact]
    public void ComposeVideoResultPayload_SerializesWithTheExpectedCamelCaseKeys()
    {
        var payload = new ComposeVideoResultPayload(true, "out.mp4", "out.srt");

        var json = JsonSerializer.Serialize(payload, PluginHostJsonContext.Default.ComposeVideoResultPayload);

        var written = JsonDocument.Parse(json);
        written.RootElement.GetProperty("success").GetBoolean().Should().BeTrue();
        written.RootElement.GetProperty("outputPath").GetString().Should().Be("out.mp4");
        written.RootElement.GetProperty("srtPath").GetString().Should().Be("out.srt");
    }

    [Fact]
    public void DraftCaptionsResultPayload_SerializesWithTheExpectedCamelCaseKeys()
    {
        var payload = new DraftCaptionsResultPayload(true, ["First caption", "Second caption"]);

        var json = JsonSerializer.Serialize(payload, PluginHostJsonContext.Default.DraftCaptionsResultPayload);

        var written = JsonDocument.Parse(json);
        written.RootElement.GetProperty("success").GetBoolean().Should().BeTrue();
        var captions = written.RootElement.GetProperty("captions").EnumerateArray().Select(e => e.GetString()).ToList();
        captions.Should().Equal("First caption", "Second caption");
    }
}
