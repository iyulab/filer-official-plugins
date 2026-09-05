using FluentAssertions;
using MediaRedactor.PluginHost;
using Xunit;

namespace MediaRedactor.PluginHost.Tests;

public class DetectRegionHandlerTests
{
    [Fact]
    public void BuildPrompt_AsksForStrictJsonCoordinates()
    {
        var prompt = DetectRegionHandler.BuildPrompt("the folder sidebar on the left");

        prompt.Should().Contain("the folder sidebar on the left");
        prompt.Should().Contain("JSON");
        prompt.Should().Contain("\"x\"");
        prompt.Should().Contain("width");
    }

    [Fact]
    public void ParseCoordinates_ValidJson_ReturnsAllFourFields()
    {
        var (x, y, width, height) = DetectRegionHandler.ParseCoordinates(
            "{\"x\": 10, \"y\": 20, \"width\": 100, \"height\": 50}");

        x.Should().Be(10);
        y.Should().Be(20);
        width.Should().Be(100);
        height.Should().Be(50);
    }

    [Fact]
    public void ParseCoordinates_JsonEmbeddedInProseResponse_StillExtractsIt()
    {
        // Vision models frequently wrap a JSON answer in prose despite being asked for strict JSON —
        // this is not a hypothetical, it's the default behavior of most chat-tuned models. Extract
        // the first {...} block rather than requiring the whole response to be bare JSON.
        var (x, y, width, height) = DetectRegionHandler.ParseCoordinates(
            "Sure! The region is: {\"x\": 10, \"y\": 20, \"width\": 100, \"height\": 50}. Let me know if you need adjustments.");

        x.Should().Be(10);
        y.Should().Be(20);
        width.Should().Be(100);
        height.Should().Be(50);
    }

    [Fact]
    public void ParseCoordinates_NoJsonFound_ThrowsWithTheRawResponseInTheMessage()
    {
        var act = () => DetectRegionHandler.ParseCoordinates("I couldn't find that region in the image.");

        act.Should().Throw<InvalidOperationException>()
            .WithMessage("*I couldn't find that region*");
    }
}
