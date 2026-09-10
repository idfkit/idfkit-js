# Why a choice value is written twice differently

`writeIdf` writes the choice value the way the author wrote it. `writeEpJson`
writes the way the schema declares it. Same document, same field, two answers:

```ts
const { document } = parseIdf('Version,26.1;\nScheduleTypeLimits,On/Off,0,1,DISCRETE;', schema);

writeIdf(document); //   ... DISCRETE;
writeEpJson(document); // ... "numeric_type": "Discrete"
```

That looks like an inconsistency and is the opposite of one. The two formats are
read by two different readers inside EnergyPlus, and those readers disagree.

## The two readers

The IDF reader matches a choice case-insensitively. `DISCRETE`, `Discrete` and
`discrete` all select the same member, and a file written in any of them runs.

The epJSON reader is JSON Schema validation, and `enum` matching there is exact.
A value that differs from the declared member by one letter's case is not a
near miss — it is:

```
** Severe  ** <root>[ScheduleTypeLimits][On/Off][numeric_type]
              - "DISCRETE" - Failed to match against any enum values.
**  Fatal  ** Errors occurred on processing input file.
```

So a writer that echoes the file's casing into epJSON turns a model that runs
into a model that does not, and it does it to inputs nobody authored badly:
`CounterClockWise` is what the EnergyPlus example files themselves contain, and
a `Wetbulb` (declared `WetBulb`) arrives in a design day from a downloaded DDY.

## What EnergyPlus does about it

`ConvertInputFormat` is not expressing a house style when it rewrites these. It
is doing the thing that makes its own output loadable. The rule is in
`IdfParser::parse_value`: match the written token against the field's choice
list case-insensitively, and emit the member it matched.

Two details of that rule are worth stating, because both are easy to get wrong
from the outside:

- **It is not title-casing, and not any rule derivable from the token.** The
  schema declares `Counterclockwise` with one capital. A library clever about
  word boundaries emits `CounterClockWise` and is still wrong. The enum member
  is the only correct source.
- **`retaincase` does not exempt a choice.** Seven fields across the bundled
  versions carry both a choice list and the schema's `retaincase` marker, and
  the enum branch of that parser consults nothing else. `retaincase` governs the
  values EnergyPlus's own reader would otherwise upper-case; this library
  upper-cases nothing, so the marker has nothing to protect here.

## Where this library does it

At the epJSON boundary — `toJSON`, and so `writeEpJson` and `toEpJson` — and
nowhere else.

Canonicalising at parse time would be one line shorter and wrong. The stored
value would become the schema's spelling, and `writeIdf` would then rewrite a
file it was asked to read back: the author's `CounterClockWise` runs, and
editing one field of one object is not a licence to restyle the other 40,000.
Preserving as-written casing is correct for the text format and a defect for the
object notation, so the fix belongs where the formats part, not before them.

Two consequences follow from putting it there:

- A value that matches no member is emitted exactly as it stands. Canonicalising
  is not validating, and a writer that repaired a value nobody declared would
  hide the fault from `validateDocument`, which is what reports it.
- A document read from epJSON and written back untouched comes back byte for
  byte, its own casing included. That is what preserving means, and it is
  reproducing an input rather than producing output.

## Why validation cannot catch this

`validateDocument` compares a choice case-insensitively, which is correct: it
answers for the model, and the model is what the text format accepts. So a
document whose epJSON will fatal reports `isValid: true` with no findings, and
no amount of validation before the write would have said otherwise. The
canonicalisation is what closes that gap, not a stricter gate.

## How it was found

Not by comparing the two idfkit libraries. Both preserved as-written casing,
both agreed, and both were wrong — 54,468 occurrences across 749 of the
EnergyPlus example files. Only running EnergyPlus's own converter over the same
inputs showed it, which is the argument [conformance](conformance.md) makes at
greater length: agreement between two implementations is not correctness.
