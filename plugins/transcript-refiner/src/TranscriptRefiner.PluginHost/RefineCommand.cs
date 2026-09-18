using System.Globalization;
using System.Text.Json;
using Microsoft.Extensions.AI;
using PulsaTranscript;

namespace TranscriptRefiner.PluginHost;

/// <summary>
/// refine_transcript: read a WebVTT transcript (and an optional glossary), let Pulsa's TranscriptRefiner fix what
/// the speech-to-text step misheard with the caller's model, and write the refined transcript plus a changes file
/// (applied and rejected-with-original). This plugin holds no refinement logic of its own — cue count and
/// timings are kept by the SDK, and a correction its gate refuses is reported, not applied.
/// </summary>
internal static class RefineCommand
{
    public static async Task<RefineTranscriptResultPayload> RunAsync(
        IChatClient chatClient, string path, string outputPath, string changesPath, string? glossaryPath,
        CancellationToken ct = default)
    {
        if (File.Exists(outputPath)) throw new InvalidOperationException($"Refusing to overwrite an existing file: {outputPath}");
        if (File.Exists(changesPath)) throw new InvalidOperationException($"Refusing to overwrite an existing file: {changesPath}");

        var cues = WebVtt.Parse(await File.ReadAllTextAsync(path, ct));
        if (cues.Count == 0) throw new InvalidOperationException($"No cues found in {Path.GetFileName(path)} — is it a WebVTT transcript?");
        var glossary = glossaryPath is null ? Glossary.Empty : Glossary.FromMarkdown(await File.ReadAllTextAsync(glossaryPath, ct));

        var result = await PulsaTranscript.TranscriptRefiner.RefineAsync(chatClient, new RefineTranscriptRequest(cues, glossary), cancellationToken: ct);

        await File.WriteAllTextAsync(outputPath, WebVtt.Write(result.Cues), ct);
        var changes = new RefineChangesFile(
            Path.GetFileName(path), result.Cues.Count,
            [.. result.Applied.Select(c => Describe(c, cues))],
            [.. result.Rejected.Select(c => Describe(c, cues))]);
        await File.WriteAllTextAsync(changesPath, JsonSerializer.Serialize(changes, typeof(RefineChangesFile), PluginHostJson.ChangesFileOptions), ct);

        return new RefineTranscriptResultPayload(
            true, outputPath, changesPath, result.Cues.Count,
            result.Applied.Count(c => c.Kind == CueChangeKind.Corrected),
            result.Rejected.Count,
            result.Applied.Count(c => c.Kind == CueChangeKind.Unclear));
    }

    private static RefinedChange Describe(CueChange change, IReadOnlyList<TranscriptCue> cues) =>
        new(change.Index + 1,
            cues[change.Index].Start.ToString(@"hh\:mm\:ss\.fff", CultureInfo.InvariantCulture),
            change.Original, change.Refined,
            change.Kind == CueChangeKind.Unclear ? "unclear" : "corrected");
}
