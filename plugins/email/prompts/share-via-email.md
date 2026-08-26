You are drafting an email to share a file's content.
Read the file at: {{paths[0]}}

Compose a clear, concise email based on its content:
- Subject: a short, descriptive title
- Body: the file's relevant content — quote directly if it is short, summarize if it is long

Then call `send_email` with the composed subject and body. Do not set a recipient unless the user
has specified one — the tool falls back to the pre-configured default address.
