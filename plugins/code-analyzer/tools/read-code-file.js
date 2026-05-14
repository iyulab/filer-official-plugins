const LANGUAGE_MAP = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', tsx: 'typescript',
  jsx: 'javascript',
  py: 'python',
  cs: 'csharp',
  java: 'java',
  cpp: 'cpp', cc: 'cpp', cxx: 'cpp',
  c: 'c', h: 'c',
  go: 'go',
  rs: 'rust',
  rb: 'ruby',
  php: 'php',
  swift: 'swift',
  kt: 'kotlin',
  scala: 'scala',
  r: 'r',
  sh: 'bash', bash: 'bash',
  ps1: 'powershell', psm1: 'powershell',
  sql: 'sql',
  html: 'html', htm: 'html',
  css: 'css', scss: 'scss', sass: 'sass', less: 'less',
  json: 'json', jsonl: 'json',
  yaml: 'yaml', yml: 'yaml',
  toml: 'toml',
  md: 'markdown', markdown: 'markdown',
  xml: 'xml', svg: 'xml',
  vue: 'vue',
  dart: 'dart',
  lua: 'lua',
  ex: 'elixir', exs: 'elixir',
};

module.exports = async function handler(params, ctx) {
  const filePath = params.path;
  if (!filePath) return { success: false, error: 'path is required' };

  const fileName = filePath.split(/[/\\]/).pop() || '';
  const ext = fileName.includes('.') ? fileName.split('.').pop()?.toLowerCase() || '' : '';
  const language = LANGUAGE_MAP[ext] || 'text';

  try {
    const buffer = await ctx.fs.read(filePath);
    const size = buffer.length;

    if (buffer.includes(0x00)) {
      return {
        success: false,
        error: 'File appears to be binary.',
        path: filePath,
        extension: ext,
        language,
        size,
      };
    }

    const content = buffer.toString('utf-8');
    const lineCount = content.split('\n').length;

    return {
      success: true,
      path: filePath,
      fileName,
      extension: ext,
      language,
      size,
      lineCount,
      content,
    };
  } catch (e) {
    return { success: false, error: e.message, path: filePath };
  }
};
