# How conformance is established

The test suite that matters is not the unit tests. It is
`packages/core/tests/roundtrip.test.ts`, which takes the IDF files EnergyPlus
ships, parses each one, writes it back out, parses the result again, and requires
the two documents to be deeply equal.

```
files          760
clean          760
parse issues   0
roundtrip diff 0
objects        290,313
throughput     ~36k objects/sec (parse + write + re-parse)
```

## Why the example set rather than fixtures

Because hand-written fixtures test the format you already understand.

The example set contains every extensible shape, autosized and autocalculated
fields, blank names, odd type names, objects whose field count differs from what
the schema nominally allows, and single high bytes in station names that are not
valid UTF-8. Nobody writing fixtures from the specification produces those cases,
because the specification is not where they come from — real models are.

Every bug fixed in this library so far came out of that loop rather than from
writing a test first. That is a statement about IDF, not about discipline:
[the format's hazards](positional-format-hazards.md) are invisible in a single
parse and obvious in a round trip.

## Why deep equality, and why twice

A single parse proves nothing about the writer. Comparing input text to output
text proves too much, because formatting is deliberately not preserved.

Parsing the _output_ and comparing the two documents isolates exactly the
property that matters: no information was lost or displaced in the write. A
shifted field survives one parse unnoticed and shows up immediately here,
because the value lands in a different slot the second time round.

## How it stays running

The suite skips cleanly when no EnergyPlus installation is present, so a
contributor without one still gets a green `npm test`. That would make it easy
for the suite to quietly stop running anywhere, so CI installs EnergyPlus, runs
the tests, and then separately asserts that the example directory exists —
failing the job if it does not. A conformance job that proved nothing should say
so.

When a bug is found this way, the fix comes with a case in
`packages/core/tests/regressions.test.ts`, so the specific shape is pinned
independently of whether the example set still happens to contain it.

## What it does not cover

Round-trip equality is not validation. It proves the library reads and writes
what is on disk faithfully; it says nothing about whether the model is
physically sensible or whether EnergyPlus will accept it. Full schema validation
is [deliberately absent](parity.md) for now.

It also does not protect against the two implementations of this format drifting
apart. Each passes its own tests. See
[Parity with the Python library](parity.md#the-drift-problem).
