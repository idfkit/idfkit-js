# Explanation

Why the library is shaped the way it is. Nothing here is needed to use it, but
each decision is visible in how the API behaves, so knowing the reasoning makes
the behaviour predictable instead of surprising.

Five properties define the design. Each was chosen over an obvious alternative,
for a reason that is not visible from the code alone:

- [A synchronous core with async edges](sync-core-async-edge.md) — why
  `parseIdf` takes a string and never a path.
- [Why accessors and not a `Proxy`](accessors-not-proxies.md) — why
  `zone.ceiling_height` is a real property.
- [Static types generated from the schema](generated-types.md) — how a
  misspelled field name becomes a compile error.
- [Content-addressed schemas](content-addressed-schemas.md) — how 17 versions fit
  in about 1 MB.
- [Why epJSON field names are used verbatim](epjson-field-names.md) — why it is
  `zone_name` and not a converted form.

Two more topics are about the format rather than the library:

- [The hazards of a positional format](positional-format-hazards.md) — the two
  rules that exist because breaking them corrupts a model silently.
- [How conformance is established](conformance.md) — why the EnergyPlus example
  set, and not hand-written fixtures, is the test suite that matters.

And one about the wider project:

- [Parity with the Python library](parity.md) — what is deliberately absent, and
  the drift problem that comes with two implementations of one format.
