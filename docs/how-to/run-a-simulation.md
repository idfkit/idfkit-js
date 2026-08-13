# How to run a simulation

idfkit-js stops at the model. To simulate one, hand the IDF text to
[`@idfkit/engine`](https://www.npmjs.com/package/@idfkit/engine), which runs
EnergyPlus in the browser via WebAssembly.

The seam between the two libraries is plain IDF text, which is the practical
payoff of [keeping this core synchronous and
string-based](../explanation/sync-core-async-edge.md).

## Install and serve the engine assets

```bash
npm install @idfkit/core @idfkit/schemas @idfkit/engine @idfkit/engine-assets
npx idfkit-engine-assets public/energyplus   # copy the WASM engine to your own origin
```

## Edit, hand over, read back

```ts
import { parseIdf, writeIdf, SchemaBundle, httpSource } from '@idfkit/core';
import { createEnergyPlus } from '@idfkit/engine';

// 1. Edit the model here.
const schema = await new SchemaBundle(httpSource('/schemas/')).load('26.1.0');
const { document } = parseIdf(idfText, schema);
document.require('Zone', 'SPACE1-1').ceiling_height = 3;

// 2. Hand it over as IDF text. Loading compiles a ~28 MB binary, so create the
//    engine once and reuse it across runs.
const ep = await createEnergyPlus({ assetBaseUrl: '/energyplus' });
const result = await ep.run({ idf: writeIdf(document), epw: epwText });

// 3. A failed run is data, not an exception: the err report is worth reading.
if (result.success) {
  console.log(result.eso?.variables.size, 'output variables');
} else {
  console.error(result.fatalError, result.err?.entries);
}
ep.dispose();
```

## Three things to know at the boundary

### Keep the versions aligned

`@idfkit/engine-assets` is versioned by the EnergyPlus release it carries, so
`@idfkit/engine-assets@26.1.0` is EnergyPlus 26.1.0. A document here can be any
of the [17 supported versions](../reference/versions.md), so load the schema that
matches the asset package you installed.

Nothing checks this for you. A mismatch means the engine reads a model written
for a different release.

### `HVACTemplate:*` objects need no special handling

`run()` expands them with the bundled ExpandObjects preprocessor before
simulating. Call `expandObjects` from `@idfkit/engine` yourself only when you
want the expanded IDF back — and if you do, `parseIdf` reads it straight into a
document.

### Results do not come back through this library

The engine returns its own parsed `err`, `eso`, and `mtr` structures, along with
raw `sql` and `html`. idfkit-js has no output-reading API and is not planning
one. Re-parsing expanded IDF is the only return path that involves it.

!!! note

    `@idfkit/engine` is developed in a private repository. Link to npm rather
    than to GitHub in anything public.
