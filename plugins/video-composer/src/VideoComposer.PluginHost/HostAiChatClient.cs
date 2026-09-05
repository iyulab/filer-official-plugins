using Microsoft.Extensions.AI;

namespace VideoComposer.PluginHost;

/// <summary>
/// An IChatClient that never holds a provider credential — every completion is a nested
/// `ai.complete` request issued back to the host over the same stdio pipe this process was called
/// on. This is the ONLY IChatClient this plugin ever constructs — CaptionDrafter (Pulsa's SDK) has
/// no idea this is how its injected client actually works.
/// </summary>
public sealed class HostAiChatClient(StdioJsonRpc rpc) : IChatClient
{
    public async Task<ChatResponse> GetResponseAsync(
        IEnumerable<ChatMessage> messages, ChatOptions? options = null, CancellationToken cancellationToken = default)
    {
        var prompt = string.Join("\n\n", messages.Select(m => m.Text));
        var text = await rpc.SendRequestAsync("ai.complete", new Dictionary<string, object?> { ["prompt"] = prompt });
        return new ChatResponse(new ChatMessage(ChatRole.Assistant, text));
    }

    public IAsyncEnumerable<ChatResponseUpdate> GetStreamingResponseAsync(
        IEnumerable<ChatMessage> messages, ChatOptions? options = null, CancellationToken cancellationToken = default) =>
        throw new NotSupportedException("Streaming is not supported over the process callback channel — draft_captions uses a single completion.");

    public object? GetService(Type serviceType, object? serviceKey = null) => null;
    public void Dispose() { }
}
