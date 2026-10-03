// The image types the completion route can take as an inline image (the host's local vision models and the
// OpenAI-compatible image_url input both read these). SVG and icons are not photos or pictures it can send.
const MIME_MAP = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
};

// The host's per-image ceiling for a completion (POST /api/ai/complete).
const MAX_BYTES = 20 * 1024 * 1024;

const DEFAULT_QUESTION =
  'Describe this image in two or three sentences: the main subject, the setting, and any text you can read in it. ' +
  'Say only what the image shows.';

/**
 * describe_image — a text description of an image from the user's configured model. A route whose model sees
 * images gets the pixels; on the local route the host's image understanding (text reading + a caption) describes
 * it for the local text model. Either way the agent gets text back, so a folder run can describe its photos on any
 * model, including a text-only one.
 */
module.exports = async function handler(params, ctx) {
  const filePath = params.path;
  if (!filePath) return { success: false, error: 'path is required' };

  const fileName = filePath.split(/[/\\]/).pop() || '';
  const ext = fileName.includes('.') ? fileName.split('.').pop()?.toLowerCase() || '' : '';
  const mimeType = MIME_MAP[ext];
  if (!mimeType) {
    return {
      success: false,
      path: filePath,
      error: `describe_image takes a photo or picture (${Object.keys(MIME_MAP).join(', ')}), not .${ext || fileName}`,
    };
  }

  try {
    const buffer = await ctx.fs.read(filePath);
    if (buffer.length > MAX_BYTES) {
      return { success: false, path: filePath, error: `The image is larger than 20 MB (${(buffer.length / 1048576).toFixed(1)} MB)` };
    }

    const question = typeof params.question === 'string' && params.question.trim() ? params.question.trim() : DEFAULT_QUESTION;
    const text = await ctx.ai.complete(question, {
      imageUrls: [`data:${mimeType};base64,${buffer.toString('base64')}`],
      temperature: 0.2,
      maxTokens: 400,
    });

    const description = typeof text === 'string' ? text.trim() : '';
    if (!description) return { success: false, path: filePath, error: 'The model returned no description for this image' };

    return { success: true, path: filePath, fileName, description };
  } catch (e) {
    // The host's own words reach the agent — on the local route they say how to install image understanding.
    return { success: false, path: filePath, error: e.message };
  }
};
