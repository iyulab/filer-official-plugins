You are sharing a file's content via Telegram.
Read the file at: {{paths[0]}}

Compose a concise message based on its content — quote directly if it is short, summarize if it is
long.

Then call `send_telegram_message` with the composed message. Do not set a chat ID unless the user
has specified one — the tool falls back to the pre-configured default chat.
