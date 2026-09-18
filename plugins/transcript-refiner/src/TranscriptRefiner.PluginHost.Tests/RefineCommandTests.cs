using System.Text.Json;
using FluentAssertions;
using Microsoft.Extensions.AI;
using TranscriptRefiner.PluginHost;
using Xunit;

namespace TranscriptRefiner.PluginHost.Tests;

public sealed class RefineCommandTests : IDisposable
{
    private readonly string _dir = Directory.CreateTempSubdirectory("transcript-refiner-test-").FullName;

    public void Dispose()
    {
        try { Directory.Delete(_dir, recursive: true); } catch (IOException) { /* temp dir cleanup is best-effort */ }
    }

    private const string Vtt = """
        WEBVTT

        00:00:00.000 --> 00:00:04.000
        지금부터 마케팅 팀 주간 회를 시작하겠습니다

        00:00:04.000 --> 00:00:08.000
        참석자는 김인수 팀장과 박준호 사원입니다

        00:00:08.000 --> 00:00:10.000
        Volt enorme
        """;

    /// <summary>A model that answers with fixed "[n] text" lines — the reply shape the SDK asks for (segments numbered from 0).</summary>
    private sealed class ScriptedModel(string reply) : IChatClient
    {
        public int Calls { get; private set; }
        public Task<ChatResponse> GetResponseAsync(IEnumerable<ChatMessage> messages, ChatOptions? options = null, CancellationToken cancellationToken = default)
        {
            Calls++;
            return Task.FromResult(new ChatResponse(new ChatMessage(ChatRole.Assistant, reply)));
        }
        public IAsyncEnumerable<ChatResponseUpdate> GetStreamingResponseAsync(IEnumerable<ChatMessage> messages, ChatOptions? options = null, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public object? GetService(Type serviceType, object? serviceKey = null) => null;
        public void Dispose() { }
    }

    private string Write(string name, string text)
    {
        var p = Path.Combine(_dir, name);
        File.WriteAllText(p, text);
        return p;
    }

    [Fact]
    public async Task Writes_the_refined_transcript_and_a_changes_file_keeping_every_cue_and_timing()
    {
        var source = Write("m.vtt", Vtt);
        var model = new ScriptedModel("[0] 지금부터 마케팅 팀 주간 회의를 시작하겠습니다\n[2] [unclear]");

        var result = await RefineCommand.RunAsync(model, source, Path.Combine(_dir, "m.clean.vtt"), Path.Combine(_dir, "m.changes.json"), null);

        result.Success.Should().BeTrue();
        result.Cues.Should().Be(3);
        result.Applied.Should().Be(1);
        result.Unclear.Should().Be(1);
        var refined = File.ReadAllText(result.OutputPath);
        refined.Should().Contain("주간 회의를").And.Contain("[unclear]").And.Contain("00:00:08.000 --> 00:00:10.000");
        using var changes = JsonDocument.Parse(File.ReadAllText(result.ChangesPath));
        changes.RootElement.GetProperty("applied").GetArrayLength().Should().Be(2);
        changes.RootElement.GetProperty("applied")[0].GetProperty("original").GetString().Should().Contain("주간 회를");
    }

    [Fact]
    public async Task A_correction_the_gate_refuses_is_reported_with_its_original_not_applied()
    {
        var source = Write("m.vtt", Vtt);
        // Rewriting a whole cue into something else is not a mishearing fix — the SDK's gate refuses it.
        var model = new ScriptedModel("[1] 오늘 회의는 취소되었습니다 그리고 다음 주로 미룹니다");

        var result = await RefineCommand.RunAsync(model, source, Path.Combine(_dir, "m.clean.vtt"), Path.Combine(_dir, "m.changes.json"), null);

        result.Rejected.Should().Be(1);
        File.ReadAllText(result.OutputPath).Should().Contain("참석자는 김인수 팀장과 박준호 사원입니다");
        using var changes = JsonDocument.Parse(File.ReadAllText(result.ChangesPath));
        changes.RootElement.GetProperty("rejected")[0].GetProperty("original").GetString().Should().Contain("김인수");
    }

    [Fact]
    public async Task Refuses_to_overwrite_and_asks_the_model_nothing()
    {
        var source = Write("m.vtt", Vtt);
        var existing = Write("m.clean.vtt", "keep me");
        var model = new ScriptedModel("");

        var act = () => RefineCommand.RunAsync(model, source, existing, Path.Combine(_dir, "m.changes.json"), null);

        await act.Should().ThrowAsync<InvalidOperationException>().WithMessage("*overwrite*");
        File.ReadAllText(existing).Should().Be("keep me");
        model.Calls.Should().Be(0);
    }

    [Fact]
    public async Task A_file_with_no_cues_is_refused_with_a_reason()
    {
        var source = Write("notes.vtt", "just some notes, not a transcript");

        var act = () => RefineCommand.RunAsync(new ScriptedModel(""), source, Path.Combine(_dir, "o.vtt"), Path.Combine(_dir, "o.json"), null);

        await act.Should().ThrowAsync<FormatException>().WithMessage("*WEBVTT*");
    }
}
