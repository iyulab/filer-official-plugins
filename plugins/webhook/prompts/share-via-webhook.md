You are sharing a file via a generic webhook.
Read the file at: {{paths[0]}}

Compose a short excerpt from its content — quote directly if it is short, summarize if it is long.
Keep the excerpt under 500 characters: the receiver is a program, not a person, so keep it compact
and factual rather than conversational.

Then call `webhook_send` with:
- event: "file.shared"
- payload: {
    "name": "{{filename}}",
    "path": "{{paths[0]}}",
    "extension": "{{extension}}",
    "size": {{fileSize}},
    "excerpt": <the excerpt you composed>
  }
