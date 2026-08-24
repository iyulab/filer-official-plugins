Call the `ReadImageText` tool with `imagePath` set to `{{paths[0]}}` to extract the text from this
image via OCR. Do not use `get_image_data`, `ReadScreenText`, or any other tool for this — the image
is a file on disk, not a screen region, and `ReadImageText` is the tool built specifically for reading
text out of an image file.

Once you have the OCR result, present it back to the user:

- Preserve the original text exactly as written (including capitalization and punctuation)
- Preserve the logical reading order (top to bottom, left to right) and paragraph/section breaks
- If the recognized content is structured (tables, forms, lists), reformat it using Markdown
- If `ReadImageText` reports no text recognized, state that clearly rather than guessing at content
