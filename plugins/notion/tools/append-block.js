const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

export default async function(params, ctx) {
  const apiKey = await ctx.settings.get('notion.apiKey');
  if (!apiKey) throw new Error('Notion API Key not configured. Set it in Settings > Extensions.');

  const children = params.content.split('\n').filter(Boolean).map(line => ({
    object: 'block',
    type: 'paragraph',
    paragraph: {
      rich_text: [{ type: 'text', text: { content: line } }],
    },
  }));

  const res = await ctx.fetch(`${NOTION_API}/blocks/${params.pageId}/children`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Notion-Version': NOTION_VERSION,
    },
    body: JSON.stringify({ children }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`Notion API error (${res.status}): ${body.message || res.statusText}`);
  }

  return { success: true, blocksAdded: children.length };
}
