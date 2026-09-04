// The honest declaration: `idfkit/language` is `@idfkit/language`, whole.
//
// @idfkit/language is an OPTIONAL peer dependency. Installing `idfkit` does not
// install it, so this re-export is unresolvable until it is added:
//
//     npm install @idfkit/language
//
// TypeScript only reads this file when something imports `idfkit/language`, so a
// project that never touches the subpath type-checks clean with the peer absent
// (FR-046). A project that does import it and has not installed the peer gets
// TS2307 naming @idfkit/language, on the line below.
export * from '@idfkit/language';
