---
hide:
  - navigation
---

<div class="hero" markdown>

# idfkit-js

<p class="hero-tagline">EnergyPlus IDF and epJSON parsing and manipulation for JavaScript and TypeScript. Synchronous, dependency-free, and typed from the schema.</p>

<div class="hero-buttons" markdown>
[Build your first model](tutorials/first-model.md){ .md-button .md-button--primary }
[How-to guides](how-to/index.md){ .md-button }
[API reference](reference/index.md){ .md-button }
</div>

</div>

<div class="feature-chips" markdown>
<span class="chip">17 EnergyPlus versions</span>
<span class="chip">Zero runtime dependencies</span>
<span class="chip">Node · browser · worker · edge</span>
<span class="chip">760 example files round-tripped</span>
</div>

```ts
import { loadIdf, saveIdf } from '@idfkit/core/node';
import type { TypeMap } from '@idfkit/types-v26-1';

const doc = await loadIdf<TypeMap>('model.idf');

for (const zone of doc.all('Zone')) {
  console.log(zone.name, zone.ceiling_height); // typed, autocompleted
}

// Renaming rewrites every reference to the old name.
doc.require('Zone', 'SPACE1-1').name = 'Open Office';

await saveIdf(doc, 'model-renamed.idf');
```

!!! warning "Status: prototype"

    The core is complete and tested against the full EnergyPlus example set, but
    nothing has been published to npm and the API is not yet stable. See
    [Parity with the Python library](explanation/parity.md) for what is
    deliberately missing.

## The packages

<div class="grid cards" markdown>

- :material-file-tree: **`@idfkit/core`**

  ***

  The parser, the object model, the live reference graph, and the writers.
  Synchronous and free of I/O, so the same code runs in Node, a browser, a
  worker, and an edge runtime.

  [Reference](reference/core.md)

- :material-database: **`@idfkit/schemas`**

  ***

  Every supported EnergyPlus schema, content-addressed down to about 1 MB
  gzipped for all 17 versions instead of 11.9 MB.

  [Reference](reference/schemas.md)

</div>

It sits alongside
[`@idfkit/engine`](https://www.npmjs.com/package/@idfkit/engine), which runs
EnergyPlus itself in the browser via WebAssembly. This project handles the model;
that one handles the simulation. They meet over IDF text — see
[How to run a simulation](how-to/run-a-simulation.md).

## What makes it different

<div class="grid cards" markdown>

- :material-language-typescript: **Typed from the schema**

  ***

  858 generated interfaces per version, so a misspelled field name is a compile
  error. In the Python library the same typo is a `None` you discover at
  simulation time.

  [How it works](explanation/generated-types.md)

- :material-lightning-bolt: **Real accessors, not a `Proxy`**

  ***

  `zone.ceiling_height` is an ordinary property on a shared prototype, so
  editors can see it and V8 can optimize it. The setter is what keeps the
  reference graph live.

  [Why](explanation/accessors-not-proxies.md)

- :material-package-variant-closed: **All 17 versions, ~1 MB**

  ***

  87% of object-type definitions are identical across releases, so each is
  stored once and shared by content hash. A cross-version diff is a manifest
  comparison, not a deep walk.

  [Why](explanation/content-addressed-schemas.md)

- :material-check-decagram: **Proved against real models**

  ***

  The conformance suite is the 760 IDF files EnergyPlus ships: parsed,
  written, and re-parsed, with deep equality required. 290,313 objects, zero
  differences.

  [How](explanation/conformance.md)

</div>

## Documentation

- **[Tutorials](tutorials/index.md)** — start here if the library is new to you.
- **[How-to guides](how-to/index.md)** — recipes for specific tasks.
- **[Reference](reference/index.md)** — the API, generated from the source.
- **[Explanation](explanation/index.md)** — why the library is shaped this way.
