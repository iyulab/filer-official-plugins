/**
 * Pure MIME bodyStructure-tree walking for the email IMAP listener.
 * Kept dependency-free and side-effect-free so it is unit-testable without
 * a live IMAP connection.
 */

/**
 * A part is a body candidate (not an attachment) when it carries no
 * Content-Disposition header at all, or an explicit `inline` disposition —
 * mirrors imapflow's own body-vs-attachment convention (its
 * `(!meta.disposition || meta.disposition === 'inline') && isTextNode` check
 * when deciding what `download()` treats as the message text).
 * @param {{disposition?:string|false}} node
 * @returns {boolean}
 */
function isBodyCandidate(node) {
  return !node.disposition || node.disposition === 'inline';
}

/**
 * Walk a fetched bodyStructure tree (depth-first, first-match) to find the
 * best available text part to download. Prefers text/plain; falls back to
 * text/html (still MIME-decoded by imapflow's download(), just literal
 * markup) if no text/plain part exists anywhere in the structure. A
 * text/plain or text/html part with Content-Disposition: attachment is
 * skipped even though its type matches — otherwise a text file attached
 * ahead of the real body in the MIME tree would be mistaken for the message
 * content.
 * @param {object} structure - MessageStructureObject (message.bodyStructure)
 * @returns {{node:object, type:'text/plain'|'text/html'}|null}
 */
function findTextPart(structure) {
  let htmlFallback = null;

  const visit = (node) => {
    if (!node) return null;
    if (node.type === 'text/plain' && isBodyCandidate(node)) return node;
    if (node.type === 'text/html' && isBodyCandidate(node) && !htmlFallback) htmlFallback = node;
    if (Array.isArray(node.childNodes)) {
      for (const child of node.childNodes) {
        const found = visit(child);
        if (found) return found;
      }
    }
    return null;
  };

  const plain = visit(structure);
  if (plain) return { node: plain, type: 'text/plain' };
  if (htmlFallback) return { node: htmlFallback, type: 'text/html' };
  return null;
}

/**
 * Walk a fetched bodyStructure tree collecting every leaf part that is NOT a
 * body candidate (see isBodyCandidate) — every attachment, image, or other
 * non-text-body payload the message carries, including a text/plain or
 * text/html part explicitly marked `disposition: attachment` (the same kind
 * findTextPart deliberately skips as the message body). A multipart
 * container node is never itself an attachment — only its leaf children can
 * carry content, so containers are walked through, not collected.
 *
 * ISSUE-filer-20260820-email-inbound-attachments-silently-dropped.md.
 * HD-53 step 1: this plugin never looked at what findTextPart skips — fixed
 * by this function existing at all. HD-56 step 2: `part` is included so a
 * caller can pass it straight to imapflow's `client.download(uid, part,
 * {uid:true})` (the same shape downloadTextBody already uses) to fetch the
 * actual bytes — this module stays pure/side-effect-free per its header, so
 * downloading is the caller's job (imap-service.js).
 * @param {object} structure - MessageStructureObject (message.bodyStructure)
 * @returns {{filename:string, type:string, size:number|undefined, part:string|undefined}[]}
 */
function findAttachmentParts(structure) {
  const attachments = [];
  let unnamedCount = 0;

  const visit = (node) => {
    if (!node) return;
    if (Array.isArray(node.childNodes) && node.childNodes.length > 0) {
      for (const child of node.childNodes) visit(child);
      return;
    }
    if (isBodyCandidate(node)) return;

    unnamedCount += 1;
    const filename =
      node.dispositionParameters?.filename ||
      node.parameters?.name ||
      `part-${node.part || unnamedCount}`;
    attachments.push({ filename, type: node.type, size: node.size, part: node.part });
  };

  visit(structure);
  return attachments;
}

// HD-56 step 2 (ISSUE-filer-20260820-email-inbound-attachments-silently-dropped.md):
// client-side pre-filters only, to avoid downloading an attachment over IMAP
// that the host would reject anyway. The host (`InboundAttachmentPersister.cs`)
// is the authoritative check — it re-validates size against the live
// FilerRagOptions.MaxFileSizeMB and re-checks the same extension denylist, so
// a drifted copy here only wastes bandwidth, it never creates a security gap.
const BLOCKED_ATTACHMENT_EXTENSIONS = ['.exe', '.bat', '.cmd', '.ps1', '.vbs', '.js'];
const MAX_ATTACHMENT_DOWNLOAD_BYTES = 100 * 1024 * 1024;

/**
 * @param {string} filename
 * @returns {boolean}
 */
function isBlockedAttachmentType(filename) {
  const ext = filename && filename.includes('.') ? `.${filename.split('.').pop().toLowerCase()}` : '';
  return BLOCKED_ATTACHMENT_EXTENSIONS.includes(ext);
}

/**
 * @param {number|undefined} size
 * @returns {boolean}
 */
function exceedsDownloadSizeCeiling(size) {
  return typeof size === 'number' && size > MAX_ATTACHMENT_DOWNLOAD_BYTES;
}

module.exports = {
  findTextPart,
  findAttachmentParts,
  isBlockedAttachmentType,
  exceedsDownloadSizeCeiling,
};
