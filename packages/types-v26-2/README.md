<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/idfkit/idfkit-brand/identity-2026.2/marks/mark-on-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/idfkit/idfkit-brand/identity-2026.2/marks/mark-on-light.svg">
    <img alt="idfkit" width="72" src="https://raw.githubusercontent.com/idfkit/idfkit-brand/identity-2026.2/marks/tile.png">
  </picture>
</p>

# @idfkit/types-v26-2

Generated TypeScript interfaces and a `TypeMap` for EnergyPlus 26.2.0.

[idfkit](https://idfkit.com) · [Developers](https://developers.idfkit.com) · [EnergyPlus docs](https://docs.idfkit.com) · [Envelop](https://app.idfkit.com) · [MCP](https://mcp.idfkit.com) · [Shoebox](https://shoebox.idfkit.com) · [GitHub](https://github.com/idfkit)

Opt-in. `@idfkit/core` is fully usable without it: a document with no map is
typed permissively rather than not at all, so nothing here is needed to read,
edit, or write a model (FR-040, SC-014). Install it when you want the editor to
complete field names and check them for one EnergyPlus version.

```bash
npm install --save-dev @idfkit/types-v26-2
```

```ts
import { loadIdf } from '@idfkit/core/node';
import type { TypeMap } from '@idfkit/types-v26-2';

const doc = await loadIdf<TypeMap>('model.idf');
doc.all('Zone').first?.ceiling_height; // number | 'Autosize' | 'Autocalculate' | undefined
```

## What is in here

One `index.d.ts`. No JavaScript, no `main`, no dependencies: the package is
declarations and nothing else, and CI fails the build if a single runtime byte
appears in it (`npm run check:type-packages`).

## Versioning

`@idfkit/core` is a **peer range**, not a pin. The map borrows one type from
core, `ExtensibleGroup`, and carries no runtime, so a version skew between the
two is a type error at your build and never a failure at run time. Pick the
package whose version tag matches the EnergyPlus release you are reading; the
core you install alongside it does not have to match anything.

## Regenerating

```bash
npm run codegen -- 26.2.0
```

Run from the repository root, against the schemas in the sibling `idfkit`
Python checkout. Do not edit `index.d.ts` by hand.

## License

MIT
