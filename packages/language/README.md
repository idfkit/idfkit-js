# @idfkit/language

The opt-in language service for IDF text: what completes here, what this means,
what this points at, and where a finding sits in the characters the reader is
looking at.

Peer-depends on [`@idfkit/core`](../core) and on nothing else. Everything
exported here is synchronous and free of I/O, so it runs unchanged in Node, a
browser, a worker, or behind an editor server.

**[Documentation](https://js.idfkit.com/)** ·
[API reference](https://js.idfkit.com/reference/language/)

```bash
npm install @idfkit/language
```

## Reaching it from the shared name

A project that installs `idfkit` reaches this package through a subpath:

```ts
import { completionsAt } from 'idfkit/language';
```

The subpath stays in the export map whether or not this package is installed.
Importing it without this package names the install to run rather than failing
with a bare module-resolution error, which is why the service costs a reader who
never asks for it zero bytes on disk and zero bytes in a bundle.

## No protocol

This package imports, depends on, and names nothing from any editor protocol
library. It answers in its own vocabulary and a consumer translates: `envelop`
to its own editor's shape, `idfkit-lsp` to the Language Server Protocol. The
regions it reports never cross a line boundary, because no editor token encoding
can express one that does, so the translation stays a rename rather than
arithmetic.

## Versioning

This package joins the repository's release lockstep. `@idfkit/core`,
`@idfkit/schemas`, `@idfkit/weather` and this package are versioned and released
together, and the dependency on `@idfkit/core` is an exact peer range rather than
a caret one. A service paired with a syntax layer it disagrees with would put
findings on the wrong characters, silently; the lockstep is what makes that
install unsupported rather than merely unlikely.
