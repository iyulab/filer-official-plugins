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

module.exports = { findTextPart };
