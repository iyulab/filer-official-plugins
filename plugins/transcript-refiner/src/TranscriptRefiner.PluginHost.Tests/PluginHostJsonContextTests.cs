using System.Text.Json;
using FluentAssertions;
using TranscriptRefiner.PluginHost;
using Xunit;

namespace TranscriptRefiner.PluginHost.Tests;

/// <summary>
/// The source-generated context is the only serializer the Native AOT build has (reflection is off there);
/// `dotnet test` always has reflection, so these exercise the generated metadata directly.
/// </summary>
public class PluginHostJsonContextTests
{
    [Fact]
    public void The_result_payload_serializes_with_camelCase_keys()
    {
        var json = JsonSerializer.Serialize(
            new RefineTranscriptResultPayload(true, "a.clean.vtt", "a.changes.json", 24, 3, 1, 2),
            PluginHostJsonContext.Default.RefineTranscriptResultPayload);

        var root = JsonDocument.Parse(json).RootElement;
        root.GetProperty("outputPath").GetString().Should().Be("a.clean.vtt");
        root.GetProperty("rejected").GetInt32().Should().Be(1);
        root.GetProperty("unclear").GetInt32().Should().Be(2);
    }

    [Fact]
    public void The_changes_file_serializes_through_the_generated_context_and_keeps_Korean_readable()
    {
        var options = new JsonSerializerOptions(StdioJsonRpc.ChangesFileOptions) { TypeInfoResolver = PluginHostJsonContext.Default };
        var file = new RefineChangesFile("a.vtt", 2,
            [new RefinedChange(1, "00:00:00.000", "주간 회를", "주간 회의를", "corrected")], []);

        var json = JsonSerializer.Serialize(file, typeof(RefineChangesFile), options);

        json.Should().Contain("주간 회의를");
        JsonDocument.Parse(json).RootElement.GetProperty("applied")[0].GetProperty("cue").GetInt32().Should().Be(1);
    }
}
