/**
 * `idfkit/language`, which is `@idfkit/language` behind a named-install guard.
 *
 * WHY THIS FILE IS NOT `export * from '@idfkit/language'`
 *
 * @idfkit/language is an optional peer dependency: `npm install idfkit` does not
 * install it, which is what keeps the language service off disk for the readers
 * who only read and write models (SC-015). `check-install-size.mjs` reports
 * 94.1% of the 1.875 MiB budget used with 114 KB free, and the service emits
 * more than that, so this is arithmetic rather than taste. The cost is that this
 * subpath can be imported while the package behind it is absent, and FR-046
 * requires that failure to name the component to install rather than surface as
 * a bare unresolved-module error.
 *
 * A static `export * from '@idfkit/language'` cannot do that. Static re-exports
 * are resolved and linked before any module in the graph is evaluated, so there
 * is no point at which this file's own code runs first: Node fails the link with
 *
 *     ERR_MODULE_NOT_FOUND: Cannot find package '@idfkit/language' imported from
 *     .../node_modules/idfkit/language.js
 *
 * and nothing here is ever reached. `weather.js` next to this file documents the
 * same reasoning and the `imports` fallback array that looks like the mechanism
 * for it and is not.
 *
 * WHAT THIS COSTS, AND WHAT IT DELIBERATELY DOES NOT
 *
 * A dynamic import can be caught, so the guard below is a top-level `await`.
 * That makes this module asynchronous in the module graph. It does not make the
 * API asynchronous: every name below is an ordinary synchronous binding, and the
 * service's whole point is that it is synchronous and free of input and output
 * (FR-024).
 *
 *     import { contextAt } from 'idfkit/language';
 *     const context = contextAt(text, offset, schema);   // no await, ever
 *
 * The awaited module graph is the whole price. Concretely: `require()` of this
 * subpath cannot work, which costs nothing because every package here is ESM
 * only and has no CommonJS entry point; and a bundler must support top-level
 * await, which Node >= 20, esbuild, Rollup, Vite and webpack >= 5.83 all do.
 *
 * The second cost is that a dynamic import cannot be spread with `export *`, so
 * the re-exported names are written out. That list can drift from the real
 * surface of @idfkit/language with nothing noticing, which is why it does not
 * drift silently: `npm run check:facade` reads both and fails on any difference.
 *
 * Types are not affected, and are not listed here. `language.d.ts` next to this
 * file is the plain `export * from '@idfkit/language'`, so the declared surface
 * is the peer's own, whole, including the many names that exist only as types:
 * `CursorContext`, `CompletionResult`, `Offer`, `PositionedFinding` and the rest
 * carry no runtime value and so have nothing to re-export here.
 *
 * `scanIdf` and `classify` are deliberately absent. They live in @idfkit/core
 * and reach a reader as `idfkit`, because the syntax layer serves reading and
 * writing too. Re-exporting them here would give one function two names.
 */

/** Every form of "that package is not installed" worth translating. */
const NOT_FOUND = new Set(['ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND']);

/**
 * The specifier a resolution failure was actually about.
 *
 * Node's ERR_MODULE_NOT_FOUND carries no structured field for this on 22.12:
 * the error's own properties are `stack`, `code` and `message`, and `url` is
 * undefined. The specifier is only in the message, in one place, quoted:
 *
 *     Cannot find package '@idfkit/language' imported from .../idfkit/language.js
 *     Cannot find package '@some/dep' imported from .../@idfkit/language/dist/index.js
 *
 * Both of those messages CONTAIN the string `@idfkit/language`, the second one
 * only because the peer's own file path is in it. So the test has to be the
 * quoted position and not a substring search: the second failure means the peer
 * is installed and one of its own dependencies is not, and answering that with
 * "npm install @idfkit/language" would send a reader to reinstall a package
 * they already have while the real fault went unmentioned.
 */
const UNRESOLVED = /Cannot find (?:package|module) '([^']+)'/;

/**
 * The peer, or a failure that says how to get it.
 *
 * Only a resolution failure naming @idfkit/language itself is translated.
 * Anything else, including an error thrown from inside @idfkit/language, is
 * re-thrown untouched. The bias is deliberate: a message Node phrases
 * differently in some later version falls through to the raw error rather than
 * to a confident wrong instruction, and `check-absent-component.mjs` fails on a
 * bare ERR_MODULE_NOT_FOUND reaching a reader, so that regression is loud.
 */
let language;
try {
  language = await import('@idfkit/language');
} catch (error) {
  const unresolved = UNRESOLVED.exec(String(error?.message ?? ''))?.[1];
  const absent = NOT_FOUND.has(error?.code) && unresolved === '@idfkit/language';
  if (!absent) throw error;
  throw new Error(
    "idfkit/language requires the optional component '@idfkit/language', which is not installed.\n" +
      '\n' +
      '    npm install @idfkit/language\n' +
      '\n' +
      'It is an optional peer dependency, so installing idfkit deliberately leaves it out: the ' +
      'language service stays off disk for everyone who reads and writes models without an ' +
      'editor in front of them. Everything else in idfkit works without it.',
    { cause: error }
  );
}

export const completionsAt = language.completionsAt;
export const contextAt = language.contextAt;
export const declarationAt = language.declarationAt;
export const explainAt = language.explainAt;
export const findingsIn = language.findingsIn;
export const position = language.position;
