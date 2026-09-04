/**
 * `@idfkit/language` — the opt-in language service for IDF text.
 *
 * Answers a cursor: what completes here, what this means, what this points at.
 * Positions the findings a parse and a validation already produced. Everything
 * exported here is synchronous and free of I/O, so the same code runs unchanged
 * in Node, a browser, a browser worker, and behind an editor server.
 *
 * Every answer takes the text itself and never a path (FR-026): an editor's
 * buffer differs from the file on disk whenever there are unsaved changes,
 * which is most of the time an editor is interesting. Nothing here reads a
 * file, opens a socket, consults a clock, or returns a promise, and there is no
 * service object to construct, because a service object is where state would
 * accumulate.
 *
 * The syntax layer this builds on is not re-exported. `scanIdf` and `classify`
 * come from `@idfkit/core`, which this package peer-depends on, because the
 * layer serves reading and writing too and one function deserves one name.
 *
 * Nothing here imports, depends on, or names a type from any editor protocol
 * library, and nothing here ever will. A consumer translates.
 */

export { contextAt } from './cursor.js';
export type { CursorContext } from './cursor.js';

export { completionsAt } from './complete.js';
export type { CompletionOptions, CompletionResult, Offer } from './complete.js';

export { explainAt } from './explain.js';
export type { Explanation, ExplanationResult } from './explain.js';

export { declarationAt } from './declaration.js';
export type { Declaration, DeclarationResult } from './declaration.js';

export { findingsIn, position } from './findings.js';
export type { PositionedFinding } from './findings.js';
