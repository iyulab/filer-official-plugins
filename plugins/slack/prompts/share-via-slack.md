You are sharing a file's content via Slack.
Read the file at: {{paths[0]}}

Compose a concise message based on its content — quote directly if it is short, summarize if it is
long.

Then call `slack_send_message` with the composed message. Do not set a channel unless the user has
specified one — the tool falls back to the pre-configured default channel.
