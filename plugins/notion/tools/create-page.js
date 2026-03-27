const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

export default async function(params, ctx) {
  const apiKey = await ctx.settings.get('notion.apiKey');
  if (!apiKey) throw new Error('Notion API Key not configured. Set it in Settings > Extensions.');

  const databaseId = params.databaseId || await ctx.settings.get('notion.defaultDatabaseId');
  if (!databaseId) throw new Error('No database ID provided and no default configured.');

  const children = params.content
    ? params.content.split('\n').filter(Boolean).map(line => ({
        object: 'block',
        type: 'paragraph',
        paragraph: {
          rich_text: [{ type: 'text', text: { content: line } }],
        },
      }))
    : [];

  const res = await ctx.fetch(`${NOTION_API}/pages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Notion-Version': NOTION_VERSION,
    },
    body: JSON.stringify({
      parent: { database_id: databaseId },
      properties: {
        title: { title: [{ text: { content: params.title } }] },
      },
      children,
    }),
  });

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));

    // Track failure
    const failStats = (await ctx.store.get('stats')) || { sent: 0, failed: 0 };
    failStats.failed++;
    await ctx.store.set('stats', failStats);
    ctx.viewData.set('notion.stats', failStats);

    throw new Error(`Notion API error (${res.status}): ${errBody.message || res.statusText}`);
  }

  const page = await res.json();

  // Track history
  const history = (await ctx.store.get('messageHistory')) || [];
  history.unshift({
    timestamp: Date.now(),
    database: databaseId,
    title: params.title,
    status: 'sent',
  });
  if (history.length > 100) history.length = 100;
  await ctx.store.set('messageHistory', history);
  ctx.viewData.set('notion.messageHistory', history);

  const stats = (await ctx.store.get('stats')) || { sent: 0, failed: 0 };
  stats.sent++;
  await ctx.store.set('stats', stats);
  ctx.viewData.set('notion.stats', stats);

  return { success: true, pageId: page.id, url: page.url };
}
