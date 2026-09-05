using System.Text.Json;
using FluentAssertions;
using MediaRedactor.PluginHost;
using Xunit;

namespace MediaRedactor.PluginHost.Tests;

public class ProgramDispatchTests : IDisposable
{
    private readonly string _tempDir = Directory.CreateTempSubdirectory("media-redactor-test-").FullName;

    [Fact]
    public void ParseRedactRegionParams_ReadsAllFieldsFromJsonParams()
    {
        using var doc = JsonDocument.Parse("""
            {"path":"in.png","x":10,"y":20,"width":100,"height":50,"outputPath":"out.png"}
            """);
        var request = RedactRegionHandler.ParseRequest(new JsonParams(doc.RootElement));

        request.InputPath.Should().Be("in.png");
        request.X.Should().Be(10);
        request.Y.Should().Be(20);
        request.Width.Should().Be(100);
        request.Height.Should().Be(50);
        request.OutputPath.Should().Be("out.png");
        request.StartTime.Should().BeNull();
        request.EndTime.Should().BeNull();
    }

    [Fact]
    public void ParseRedactRegionParams_WithTimeRange_ReadsBoth()
    {
        using var doc = JsonDocument.Parse("""
            {"path":"in.mp4","x":10,"y":20,"width":100,"height":50,"outputPath":"out.mp4","startTime":1.5,"endTime":3}
            """);
        var request = RedactRegionHandler.ParseRequest(new JsonParams(doc.RootElement));

        request.StartTime.Should().Be(1.5);
        request.EndTime.Should().Be(3);
    }

    public void Dispose() => Directory.Delete(_tempDir, recursive: true);
}
