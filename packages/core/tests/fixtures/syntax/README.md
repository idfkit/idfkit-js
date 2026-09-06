# Syntax fixtures

One file per edge case named in the specification for the IDF language service
(feature 005, task T002). Every one of them is text a real file can contain, and
several of them are text that does not parse, which is the point: the syntax
layer is required to be produced for text that violates the grammar and to
represent the violation rather than stopping at it.

Read them with `syntaxFixture` and `syntaxFixtures` from `tests/helpers.ts`,
which read the bytes as they are on disk. Do not read them through anything that
normalises line endings, and do not reformat them: three of them exist only to
carry a particular line ending, and an editor that helpfully converts one of
those has destroyed the fixture rather than tidied it.

| File                                      | What it is for                                                                                                  |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `empty.idf`                               | Zero bytes. The tiling invariant has to hold vacuously.                                                         |
| `comments-only.idf`                       | Comments and nothing else, and no version either.                                                               |
| `single-unterminated-word.idf`            | The four bytes `Zone`, no separator, no terminator, no trailing newline.                                        |
| `unterminated-final-statement.idf`        | A last statement with no `;`, which runs to end of input.                                                       |
| `missing-terminator-swallows-next.idf`    | A missing `;` that swallows the statement below it, so one object extends far past where it looks like it ends. |
| `line-endings-lf.idf`                     | Line feed only.                                                                                                 |
| `line-endings-crlf.idf`                   | Carriage return and line feed only, on every line.                                                              |
| `line-endings-mixed.idf`                  | Both conventions in one file, alternating.                                                                      |
| `no-trailing-newline.idf`                 | A last line with no line feed after it, which a write must not add.                                             |
| `value-across-two-lines.idf`              | A field value written across two lines, so its stored region crosses a line boundary while no drawn token may.  |
| `comment-between-separator-and-value.idf` | A comment sitting between a separator and the value that follows it.                                            |
| `comma-inside-trailing-comment.idf`       | A comma and a semicolon inside a comment trailing a value, neither of which is a delimiter.                     |
| `surface-bad-ninth-vertex.idf`            | A surface with twelve vertices whose ninth carries a value that is not a number.                                |
| `duplicate-object-name.idf`               | Two objects of one type declaring the same name, which the schema forbids and real files contain.               |
| `unknown-object-type.idf`                 | An object of a type the schema does not define.                                                                 |
| `no-version-declared.idf`                 | No `Version` statement, so no schema resolves.                                                                  |
| `unsupported-version.idf`                 | A version this repository ships no schema for.                                                                  |

The line-ending fixtures carry the same statements deliberately, so a test that
finds them classifying differently has found a line-ending bug rather than a
content difference. Their byte counts are 135, 143 and 139: identical text, four
or eight extra carriage returns.

`no-trailing-newline.idf` was added for the preserving writer (feature 006) and
is donated onward to the conformance corpus as `preserve-no-trailing-newline`.
It exists because the curated corpus holds no such file: its inputs were swept
from what one engine emits, and that engine always ends a file with a line feed.
A writer that appends one is wrong on a file that never had one, and nothing but
a fixture like this one notices.
