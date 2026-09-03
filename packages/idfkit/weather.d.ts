// The honest declaration: `idfkit/weather` is `@idfkit/weather`, whole.
//
// @idfkit/weather is an OPTIONAL peer dependency. Installing `idfkit` does not
// install it, so this re-export is unresolvable until it is added:
//
//     npm install @idfkit/weather
//
// TypeScript only reads this file when something imports `idfkit/weather`, so a
// project that never touches the subpath type-checks clean with the peer absent
// (SC-031). A project that does import it and has not installed the peer gets
// TS2307 naming @idfkit/weather, on the line below.
export * from '@idfkit/weather';
