const MIME_MAP = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  tiff: 'image/tiff',
  tif: 'image/tiff',
  avif: 'image/avif',
};

function detectImageDimensions(buffer, ext) {
  try {
    if (ext === 'png') {
      if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
        const width = buffer.readUInt32BE(16);
        const height = buffer.readUInt32BE(20);
        return { width, height };
      }
    }
    if (ext === 'jpg' || ext === 'jpeg') {
      let i = 2;
      while (i < buffer.length) {
        if (buffer[i] !== 0xFF) break;
        const marker = buffer[i + 1];
        if (marker === 0xC0 || marker === 0xC2) {
          const height = buffer.readUInt16BE(i + 5);
          const width = buffer.readUInt16BE(i + 7);
          return { width, height };
        }
        const segLen = buffer.readUInt16BE(i + 2);
        i += 2 + segLen;
      }
    }
  } catch {
    // ignore parse errors
  }
  return null;
}

module.exports = async function handler(params, ctx) {
  const filePath = params.path;
  if (!filePath) return { success: false, error: 'path is required' };

  const fileName = filePath.split(/[/\\]/).pop() || '';
  const ext = fileName.includes('.') ? fileName.split('.').pop()?.toLowerCase() || '' : '';
  const mimeType = MIME_MAP[ext] || 'application/octet-stream';

  try {
    const buffer = await ctx.fs.read(filePath);
    const size = buffer.length;
    const dimensions = detectImageDimensions(buffer, ext);

    const result = {
      success: true,
      path: filePath,
      fileName,
      extension: ext,
      mimeType,
      size,
      sizeKb: parseFloat((size / 1024).toFixed(2)),
      dimensions,
    };

    if (params.includeBase64) {
      result.base64 = buffer.toString('base64');
      result.dataUrl = `data:${mimeType};base64,${result.base64}`;
    }

    return result;
  } catch (e) {
    return { success: false, error: e.message, path: filePath };
  }
};
