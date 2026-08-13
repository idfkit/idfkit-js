# How to compare two EnergyPlus versions

Answering "what changed between 9.4 and 26.1" is a manifest comparison here, not
a deep diff of two 10 MB schema documents. Because definitions are
[content-addressed](../explanation/content-addressed-schemas.md), a type either
has the same hash in both versions or it does not.

## The diff

```ts
import { localBundle } from '@idfkit/schemas/node';

const bundle = localBundle();
const older = await bundle.load('9.4.0');
const newer = await bundle.load('26.1.0');

const delta = newer.changedFrom(older);

delta.added; // type names introduced since 9.4
delta.removed; // type names that no longer exist
delta.changed; // type names whose definition differs
```

`changedFrom` reads as "what this version changed, relative to that one", so call
it on the newer schema.

In a browser, swap `localBundle()` for
`new SchemaBundle(httpSource('/schemas/'))`; everything else is identical.

## Looking at what actually changed

`changed` gives you names. For the detail, compare the two definitions:

```ts
for (const typeName of delta.changed) {
  const before = older.get(typeName);
  const after = newer.get(typeName);

  const gained = after.f.filter((field) => !before.f.includes(field));
  const lost = before.f.filter((field) => !after.f.includes(field));

  if (gained.length || lost.length) {
    console.log(typeName, { gained, lost });
  }
}
```

A type can appear in `changed` without gaining or losing fields — a default, a
range, or a choice list may have moved instead. `f` is the positional field
order, so a change there is the one that matters most for reading old files.

## Checking whether a model would survive a version

```ts
const target = await bundle.load('26.1.0');
const unsupported = doc.types().filter((typeName) => target.resolve(typeName) === undefined);
```

That catches types removed between releases. It does not catch fields that moved
or changed meaning, and it is not a migration: this library has no
version-migration API, and the transition binaries that do it properly ship with
EnergyPlus itself. The Python
[idfkit](https://github.com/idfkit/idfkit) wraps them.

## Why this is cheap

Loading the second version only pays for definitions the two versions do not
share, and 87% of them are identical. `changed` falls out of comparing hashes,
with no structural walk at all.
