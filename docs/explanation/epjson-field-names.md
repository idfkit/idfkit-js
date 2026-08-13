# Why epJSON field names are used verbatim

Fields are `zone_name` and `outside_boundary_condition`. Not `zoneName`, not
`Zone Name`, not the Python library's converted names. There is no
name-conversion layer, and that absence is deliberate.

## The argument

epJSON names are already valid JavaScript identifiers and already valid
TypeScript interface keys. So the name on disk, the key at runtime, and the
static type all agree, exactly, with no translation step between them.

That means there is no conversion table to maintain, no round-tripping question
("does `zone_name` come back as `zone_name`?"), and no class of bug where a
field works everywhere except the one place the mapping was applied
inconsistently.

It also means the epJSON schema, the EnergyPlus documentation, an epJSON file in
a text editor, and this library all use the same word for the same thing. When
you are looking at an unfamiliar object type, whatever the schema calls the field
is what you type.

## The cost

`zone.outside_boundary_condition` is not idiomatic JavaScript. A JavaScript
library would normally offer `zone.outsideBoundaryCondition`.

That is a real cost, and it is paid deliberately. Adding a camelCase layer would
mean a bidirectional mapping applied on parse, on write, on field access, on the
reference graph, and in the type generator — five places to keep consistent, for
a cosmetic gain, in a library whose entire job is to be a faithful
representation of an EnergyPlus model.

## Where this does not apply

Method and class names are ordinary JavaScript: `danglingReferences`,
`outgoingReferences`, `IdfCollection`. The verbatim rule covers _schema-derived_
names — object type names and field names — because those are data, not API.

Object type names keep their EnergyPlus spelling too, including the colons:
`BuildingSurface:Detailed`, `HVACTemplate:Zone:VAV`. Lookup is case-insensitive,
matching EnergyPlus, so `doc.all('zone')` and `doc.all('Zone')` find the same
collection.
