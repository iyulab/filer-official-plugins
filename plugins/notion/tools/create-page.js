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
    const body = await res.json().catch(() => ({}));
    throw new Error(`Notion API error (${res.status}): ${body.message || res.statusText}`);
  }

  const page = await res.json();
  return { success: true, pageId: page.id, url: page.url };
}
