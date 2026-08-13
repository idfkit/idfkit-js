# The hazards of a positional format

IDF has no field names. An object is a type name followed by comma-separated
values, and which field a value belongs to is decided entirely by how many
commas precede it:

```idf
Zone,
    SPACE1-1,      !- Name
    0,             !- Direction of Relative North
    0, 0, 0,       !- Origin
    1,             !- Type
    1,             !- Multiplier
    2.7;           !- Ceiling Height
```

The `!-` comments are comments. EnergyPlus ignores them entirely. Delete one
value and every value after it silently becomes the wrong field.

This is why the failure mode of an IDF bug is so bad. A parser that gets a
positional rule wrong does not throw. It produces a model that loads, validates,
and simulates a different building than the one on disk.

Two rules exist in this library specifically because breaking them does that.

## Trailing fields may be trimmed only when no extensible group follows

EnergyPlus defaults omitted trailing fields, and a long run of bare commas is
noise, so the writer normally stops at the last field that has a value.

That is safe right up until the object has an extensible group. Then the group's
values follow the fixed fields in the same comma stream, and trimming a fixed
field shifts _every_ group value one slot earlier. A surface's vertices come back
with the X of one vertex read as the Z of the one before it — geometry that is
subtly, silently wrong.

So when a type has an extensible group, every fixed slot is emitted, empty or
not. `packages/core/tests/regressions.test.ts` pins this as "keeps positional
alignment when unset fields precede an extensible group".

## A blank name is not the same as no name

Three different things look similar and are not:

| Case                 | Example                          | Occupies a field slot? |
| -------------------- | -------------------------------- | ---------------------- |
| Named                | `Zone`                           | Yes                    |
| Optional name, blank | `WeatherProperty:SkyTemperature` | **Yes**                |
| No name field at all | `Version`, `GlobalGeometryRules` | No                     |

The middle case is the trap. `WeatherProperty:SkyTemperature` has a name field
that is allowed to be empty, and that empty field still consumes a position. Skip
it on write and every subsequent field of the object is off by one.

`IdfObject` therefore tracks two separate things:

- **`name`** — the name as written, which may be the empty string.
- **`key`** — the slot the object occupies in its collection.

For a normally named object these coincide. For a blank-named one the name is
`''` and the key is synthetic, so several blank-named objects of the same type
can coexist without colliding. For an anonymous type there is no name field to
write at all.

Conflating the two gives you either a collection where the second blank-named
object overwrites the first, or an output file with a missing comma. Both have
been real bugs, and both are pinned in the regression suite.

## Why these are found by round-tripping and not by review

Neither rule is visible from reading the writer. Both were found by parsing the
EnergyPlus example set, writing it back out, re-parsing, and requiring deep
equality — see [How conformance is established](conformance.md). A shifted field
is invisible in a single parse and obvious after a round trip, because the value
lands somewhere different the second time.
