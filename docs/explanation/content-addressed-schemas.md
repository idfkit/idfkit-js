# Content-addressed schemas

The raw epJSON schemas are about 10 MB each, and there are 17 of them: 11.9 MB
gzipped for the set. In a Python wheel nobody notices. On a page load it decides
your architecture.

## The observation

87% of object-type definitions are byte-identical across EnergyPlus releases.
`Zone` has not changed since 8.9. Shipping 17 schemas means shipping the same
definition of `Zone` seventeen times.

So the bundle stores each unique definition once, keyed by a hash of its
content, and gives every version a manifest mapping type name to hash.

|                                          | All 17 versions, gzipped |
| ---------------------------------------- | ------------------------ |
| Raw epJSON schemas, as Python ships them | 11,915 KB                |
| Slimmed (documentation metadata dropped) | 2,922 KB                 |
| Content-addressed                        | **~1,000 KB**            |

The two reductions are independent. Slimming drops `note`, `memo`, `ip-units`,
and `field_info` — documentation weight sitting on the critical path of every
parse. Content-addressing removes the duplication that remains. See
[Slim schema format](../reference/slim-schema-format.md) for what survives.

## The alternative that looks obvious

Publish `@idfkit/schemas-26-1`, `@idfkit/schemas-25-2`, and so on, and let people
install the one they need.

It is the wrong move, for two reasons. It duplicates the shared 87% across every
package, so the ecosystem-wide total goes _up_. And it makes cross-version work —
migration tooling, diffing, a viewer that opens whatever file it is handed —
require several installs and a dynamic import strategy, which is exactly the
audience most likely to care about size.

## Two consequences beyond size

**Loading a second version is nearly free.** The blob store is shared across a
`SchemaBundle`, so loading 26.1.0 after 9.4.0 pays only for the definitions the
two do not have in common.

**A cross-version diff is a manifest comparison.** Not a deep diff of two 10 MB
documents:

```ts
const delta = (await bundle.load('26.1.0')).changedFrom(await bundle.load('9.4.0'));
// { added: [...], removed: [...], changed: [...] }
```

`changed` falls out of comparing two hashes. There is no structural walk.

## Shared identity, and why it reaches the object model

Definitions are frozen and shared _by identity_, not merely by value:

```ts
const a = await bundle.load('25.2.0');
const b = await bundle.load('26.1.0');
a.get('Zone') === b.get('Zone'); // true
```

`@idfkit/core` keys its per-type prototypes on the definition object rather than
on the type name, so those two versions of `Zone` share one prototype. A document
holding objects from several versions stays monomorphic for free — a performance
property that came out of a size decision, and one of the reasons
[accessors rather than a `Proxy`](accessors-not-proxies.md) work as well as they
do.

Because the definitions are shared and frozen, they must not be mutated. Nothing
enforces that beyond `Object.freeze`, and a mutation would reach every version at
once.

## The stability requirement

Hashes are computed from a canonical serialization: sorted keys, fixed
separators. That canonicalization must stay stable across rebuilds. If it drifts,
every hash changes, every manifest changes, and a regeneration produces a diff
covering the entire bundle rather than the handful of definitions that actually
changed in a release — which makes the one review that matters impossible to do.
