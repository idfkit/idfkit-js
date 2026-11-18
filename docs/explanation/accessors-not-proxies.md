# Why accessors and not a `Proxy`

`zone.ceiling_height` is a real property. It is not a `Proxy` trap, and the
difference is not academic.

## The obvious translation

The Python library resolves `zone.ceiling_height` through `__getattr__`: the
attribute does not exist, Python calls a hook, the hook consults the schema. It
works, it is concise, and the mechanical translation to JavaScript is a `Proxy`.

That translation was rejected. A `Proxy` gives up two things at once:

**Editors cannot see through it.** A proxy's properties do not exist until
something asks for them, so there is nothing for TypeScript to describe and
nothing to complete. Every field name becomes a string typed from memory, and
every typo becomes a runtime `undefined`. That is precisely the failure mode of
the Python original, reproduced on purpose.

**V8 cannot optimize it.** Property access on an ordinary object is an inline
cache hit. Property access through a proxy is a call into a trap, every time. On
a 290,000-object corpus that difference is the difference between the parser
being usable in a browser and not.

## What is done instead

Each object type gets one prototype, built once by `ObjectShape`, carrying
`Object.defineProperty` accessors for every field in the schema. Every instance
of that type shares it. Reads are ordinary monomorphic property lookups, and the
generated `.d.ts` interfaces describe them statically.

Shapes are keyed by the schema definition object, not by type name. Because the
bundle is [content-addressed](content-addressed-schemas.md), `Zone` in 9.4.0 and
`Zone` in 26.1.0 are the _same_ frozen definition, so they share one shape and
one prototype. A document holding objects from two EnergyPlus versions stays
monomorphic without anyone arranging for it.

## Why the setter matters

The reference graph is live. Renaming an object rewrites every field elsewhere
that pointed at the old name:

```ts
const zone = doc.require('Zone', 'SPACE1-1');
zone.name = 'Open Office';
surface.zone_name; // 'Open Office'
```

Nothing was called to make that happen. There is no `update()`, no
`rebuildIndex()`, no invalidation step for a caller to forget. The write went
through the accessor's setter, and the setter is where the graph edge is moved.

That is the real argument for defining accessors rather than storing plain data
properties. A plain property would be faster still and would leave the graph
stale on every write, which is a correctness problem rather than a performance
one. Extensible groups are covered too: `ZoneList`, `Branch`, and the supply and
return paths carry all of their references inside repeat groups, so a graph that
ignored those would make `rename()` quietly produce a broken model.

## What an accessor cannot catch

An accessor exists only for a name the schema declares. An assignment to any
other name, `zone.ceilng_height = 4`, finds nothing on the prototype chain, and
JavaScript's default is to create a new property on the instance. The value
would read back correctly and then vanish on save, because the writers walk the
schema's fields, not the instance's keys.

Catching an arbitrary name is exactly what a `Proxy` is for, so it is not
available here. Instead every object is made non-extensible as it is built,
after its internal slots exist. Strict code, which includes every ES module and
all compiled TypeScript, gets the engine's `TypeError`; a sloppy script has the
write silently dropped, which at least reads back as `undefined` rather than as
a value that will be lost. The engine writes that message, so it never names the
object type, and only some engines name the property: Node and Chrome do,
Safari does not. `set()` and `update()` write their own message, so they name
both and suggest the field the name most likely meant. A non-extensible object keeps its hidden class, so this costs nothing on
the read and write paths.
