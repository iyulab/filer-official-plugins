You are saving a file's content to Notion.
Read the file at: {{paths[0]}}

Compose a page based on its content:
- Title: a short, descriptive title based on the file's name and content
- Content: the file's relevant content — quote directly if it is short, summarize if it is long

Then call `notion_create_page` with the composed title and content. Do not set a database ID unless
the user has specified one — the tool falls back to the pre-configured default database.
