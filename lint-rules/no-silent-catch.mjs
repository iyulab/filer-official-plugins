// A catch block that neither rethrows nor surfaces the failure (log / telemetry / user-visible
// error) makes the failure disappear without a trace. Text-scan heuristic over the catch body:
// a `throw`, or a call whose name looks like a logging, telemetry, or error-surface call, counts
// as surfacing it. A deliberate swallow is allowed, but it has to say so where the reader will
// look: `// eslint-disable-next-line local/no-silent-catch -- <reason>`.
//
// Same semantics as the rule the host application applies to its own code (and its .NET twin,
// FILER001); kept as a copy here because this repository is consumed on its own.
const SIGNAL_PATTERN =
  /\b(?:console\s*\.\s*(?:error|warn)|logger\s*\.\s*\w+|_logger\s*\.\s*\w+|log[A-Z]\w*|ctx\s*\.\s*log\s*\.\s*\w+|show(?:Error|Toast)\w*|add\w*Toast\w*|toast|track\w*|capture\w*|report(?:Error)?\w*|telemetry\w*)\s*\(/i

// A plugin tool's contract is a result object: `{ success: false, error: '...' }` is how a
// failure reaches the caller (the agent reads it and can act on it), so a catch that returns one
// has surfaced the failure. Matched on the object-literal key, not on a variable named `error`.
const ERROR_RESULT_PATTERN = /\breturn\b[^;]*?\b(?:error\s*:|success\s*:\s*false)/

const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow catch blocks that swallow an error without rethrowing, logging, or surfacing it to the user',
    },
    schema: [],
    messages: {
      silentCatch:
        'This catch block has no throw, log/telemetry call, or user-facing error signal - the failure disappears silently. Add a throw, a logger call (ctx.log.warn, console.error), or return an error result the caller can see.',
    },
  },
  create(context) {
    return {
      CatchClause(node) {
        const text = context.sourceCode.getText(node.body)
        if (/\bthrow\b/.test(text)) return
        if (SIGNAL_PATTERN.test(text)) return
        if (ERROR_RESULT_PATTERN.test(text)) return
        context.report({ node, messageId: 'silentCatch' })
      },
    }
  },
}

export default { 'no-silent-catch': rule }
