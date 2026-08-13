# Parity with the Python library

idfkit-js is a sibling of the Python
[idfkit](https://github.com/idfkit/idfkit), not a transliteration of it. Some
things are missing because they have not been written; others are missing on
purpose, and one thing here has no Python counterpart at all.

## Present

| Area                       | Notes                                                      |
| -------------------------- | ---------------------------------------------------------- |
| IDF parse and write        | Full example-set conformance                               |
| epJSON parse and write     | Round-trips against IDF                                    |
| Object model               | Typed accessors, collections, clone, extensible groups     |
| Reference graph            | Live, with rename propagation and dangling detection       |
| All 17 EnergyPlus versions | 8.9.0 through 26.1.0                                       |
| Generated static types     | Per version — [no Python equivalent](generated-types.md)   |
| Weather                    | `@idfkit/weather`: station index and browser EPW retrieval |

## Absent, with reasons

| Area                         | Why                                                                                                                                                                                                                                                                                                                  |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Simulation                   | [`@idfkit/engine`](https://www.npmjs.com/package/@idfkit/engine) already runs EnergyPlus in the browser via WASM and [pairs with this library](../how-to/run-a-simulation.md) over IDF text. Shelling out to a local install would duplicate it for the smaller audience.                                            |
| Weather design days          | [`@idfkit/weather`](../reference/weather.md) covers the station index and EPW/DDY/STAT retrieval, but not the Python library's DDY parsing, ASHRAE design-day injection into a model, the disk cache, or the `idfkit tmy` CLI. Injecting design days belongs closer to the core object model and is not written yet. |
| Geometry, schedules, thermal | Pure maths, ports cleanly, simply not written yet.                                                                                                                                                                                                                                                                   |
| Validation                   | Beyond parse-time checks. The schema data needed for it is [already in the bundle](../reference/slim-schema-format.md).                                                                                                                                                                                              |
| Formatting round-trip        | Needs a concrete syntax tree. `3.0` currently comes back as `3`: semantically identical, textually different.                                                                                                                                                                                                        |

The simulation entry deserves emphasis, because it shapes the rest of the
design. This repository handles the model; `@idfkit/engine` handles the run. They
meet over IDF text, which is only possible because
[the core is synchronous and string-based](sync-core-async-edge.md).

## The drift problem

Two implementations of a schema-driven format will diverge. The divergence is
silent, because each side passes its own tests: the Python library round-trips
against its fixtures, this one round-trips against the example set, and neither
notices that they disagree about what a blank field means until someone moves a
model between them.

The mitigation that works is a **shared conformance suite**: fixture IDFs with
expected canonical epJSON output and expected diagnostics, versioned
independently of both libraries and run by both CI pipelines. Not a test in one
repository that imports the other — that only catches drift in one direction and
couples the release cycles.

That suite does not exist yet. It should be built before the two implementations
are used together in anger, and until it does, treat cross-library agreement as
unverified rather than assumed.

If you are adding a feature here that also exists in the Python library, check
what it does there rather than inventing a behaviour. That is the cheap half of
the mitigation and it is available today.
