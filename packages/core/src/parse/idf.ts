import type { Schema, SlimType } from '@idfkit/schemas';

import { IdfDocument } from '../document.js';
import type { ExtensibleGroup, FieldValues, StoredValue } from '../object.js';
import type { AnyTypeMap, UntypedMap } from '../typemap.js';
import { lex, type LexDiagnostic, type RawObject } from './lexer.js';
import { scan } from './scan.js';

export interface ParseDiagnostic extends LexDiagnostic {
  /**
   * Object name the problem occurred in, when known.
   *
   * Python spells this `obj_name`, and `typeName` against its `obj_type` is the same idiomatic
   * casing difference the naming register already records. Not a gap, and not renamed: spending a
   * rename to make the register harder to read is the wrong trade.
   */
  objectName?: string;
}

export interface ParseOptions {
  /**
   * Throw on the first diagnostic instead of collecting them.
   * @defaultValue true
   */
  strict?: boolean;
  /** Collects diagnostics when `strict` is false. */
  onDiagnostic?: (diagnostic: ParseDiagnostic) => void;
}

export interface ParseResult<M extends AnyTypeMap = UntypedMap> {
  document: IdfDocument<M>;
  diagnostics: ParseDiagnostic[];
}

/**
 * Parse IDF text into a document.
 *
 * Synchronous and pure: text in, document out, no I/O. Everything that touches
 * the filesystem or network lives at the edges (`@idfkit/core/node`), so this
 * function behaves identically in Node, a browser, and a worker. The schema
 * must already be loaded, which is the one genuinely async step.
 */
export function parseIdf<M extends AnyTypeMap = UntypedMap>(
  text: string,
  schema: Schema,
  options: ParseOptions = {}
): ParseResult<M> {
  const strict = options.strict ?? true;
  const diagnostics: ParseDiagnostic[] = [];

  const report = (diagnostic: ParseDiagnostic): void => {
    if (strict) {
      throw new IdfParseError(diagnostic);
    }
    diagnostics.push(diagnostic);
    options.onDiagnostic?.(diagnostic);
  };

  /**
   * Record a finding that does NOT stop the parse, whatever `strict` says.
   *
   * `report` throws under `strict`, which is right for a finding that leaves nothing to return: an
   * object whose type is unknown cannot be built. A value of the wrong KIND is different. The
   * object is built, the document is complete, and a caller reading strictly gets exactly what they
   * got before this finding existed (FR-014). Routing it through `report` made a strict parse fail
   * on files that used to load, which is the opposite of additive.
   */
  const note = (diagnostic: ParseDiagnostic): void => {
    diagnostics.push(diagnostic);
    options.onDiagnostic?.(diagnostic);
  };

  const raw = lex(text, { onDiagnostic: report });
  const document = new IdfDocument<M>(schema);

  for (const object of raw) {
    const canonical = schema.resolve(object.typeName);
    if (canonical === undefined) {
      report({
        message: `Unknown object type "${object.typeName}" in EnergyPlus ${schema.version}`,
        line: object.line,
        column: object.column,
        typeName: object.typeName,
        // Best effort, and the same rule Python's `_extract_object_name` uses: the first positional
        // value is the name for every named type, and is a real field for the anonymous ones. An
        // unknown type has no definition to tell the two apart, so the raw first value is what there
        // is. Declaring `objectName` and never filling it would make the field a claim rather than a
        // value.
        objectName: object.values[0],
        code: 'UnknownObjectType',
      });
      continue;
    }

    const definition = schema.require(canonical);
    try {
      const invalid: { field: string; index: number; value: string }[] = [];
      const { name, values } = interpret(definition, object, invalid);
      document.addRaw(canonical, definition.anon === 1 ? null : name, values);

      // Reported after the object is built, never instead of building it: a value of the wrong
      // kind does not stop the parse, so a caller reading strictly gets the document they always
      // got. This adds a finding where there was silence, and nothing else.
      //
      // Positioned at the offending FIELD rather than at the object, because that is what makes it
      // useful. The shape this catches is a missing semicolon swallowing the object below, and the
      // object's own first line is nowhere near the damage.
      for (const { field, index, value } of invalid) {
        if (stringIsLegal(definition, field, value)) continue;
        note({
          message: `Field "${field}" expects a number, got "${value}"`,
          line: fieldLine(text, object, index),
          typeName: canonical,
          objectName: definition.anon === 1 ? undefined : object.values[0],
          code: 'InvalidField',
        });
      }
    } catch (error) {
      report({
        message: error instanceof Error ? error.message : String(error),
        line: object.line,
        column: object.column,
        typeName: canonical,
        objectName: definition.anon === 1 ? undefined : object.values[0],
        code: 'ParseError',
      });
    }
  }

  return { document, diagnostics };
}

/** Map positional IDF values onto named schema fields. */
function interpret(
  definition: SlimType,
  object: RawObject,
  invalid?: { field: string; index: number; value: string }[]
): { name: string; values: FieldValues } {
  const order = definition.f;
  const named = definition.anon !== 1 && order[0] === 'name';
  const values: FieldValues = {};

  let cursor = 0;
  let name = '';

  if (named) {
    name = object.values[0]?.trim() ?? '';
    if (name === '' && definition.nreq === 1) {
      throw new Error(`${object.typeName} requires a name`);
    }
    cursor = 1;
  }

  const fixed = named ? order.slice(1) : order;
  for (const field of fixed) {
    const index = cursor;
    const raw = object.values[cursor++];
    if (raw === undefined) break;
    if (raw === '') continue;
    const coerced = coerce(definition, field, raw);
    if (coerced !== undefined) values[field] = coerced;
    // A numeric field that kept its string is a coercion that fell through. Whether that is
    // actually wrong needs the schema and is asked on the reporting path, which runs almost never.
    if (invalid !== undefined && coerced === raw && isNumericField(definition, field)) {
      invalid.push({ field, index, value: raw });
    }
  }

  // Everything past the fixed fields belongs to the extensible section, read in
  // repeats of the group width. A trailing partial group is kept rather than
  // dropped: files in the wild are truncated, and losing data on a round-trip
  // is worse than carrying an incomplete group.
  const extensible = definition.x;
  if (extensible !== undefined) {
    const width = extensible.fields.length;
    const groups: ExtensibleGroup[] = [];
    let lastPopulated = -1;
    while (cursor < object.values.length) {
      const group: ExtensibleGroup = {};
      let populated = false;
      for (let offset = 0; offset < width; offset += 1) {
        const raw = object.values[cursor++];
        if (raw === undefined || raw === '') continue;
        const field = extensible.fields[offset]!;
        const coerced = coerceExtensible(definition, field, raw);
        if (coerced !== undefined) {
          group[field] = coerced;
          populated = true;
        }
      }
      if (populated) lastPopulated = groups.length;
      groups.push(group);
    }
    // An all-blank repeat in the middle is kept, because the section is
    // positional: dropping it pulls every later group down a slot, so a surface
    // silently loses a vertex and its `number_of_vertices` stops matching.
    // Trailing blanks are padding rather than data, and are dropped.
    groups.length = lastPopulated + 1;
    if (groups.length > 0) values[extensible.key] = groups;
  }

  return { name, values };
}

/**
 * The two sizing sentinels, accepted in ANY numeric field.
 *
 * Not read from the field's own `se` branch, deliberately. The schema EnergyPlus ships is NARROWER
 * than the engine it ships with, and its own example files prove it. Both of these declare a string
 * branch naming exactly one sentinel, and the shipped files use the other one:
 *
 *   `PlantLoop.plant_loop_volume` allows `Autocalculate`; 28 files write `Autosize`.
 *   `AirTerminal:SingleDuct:VAV:Reheat.maximum_flow_fraction_during_reheat` allows `Autosize`;
 *   673 files write `Autocalculate`.
 *
 * The schema is well formed: across all 17 bundled versions no field declares a non-numeric string
 * default on a numeric type with no string branch. It is simply stricter about WHICH sentinel
 * belongs where than EnergyPlus is. Reading each field's branch literally produced 3,775 findings
 * across the 760 example files of one release, every one against a model EnergyPlus reads happily.
 *
 * A parse finding says the value is not of the kind the field takes. Whether the exact sentinel is
 * the one THIS field documents is a schema question, and `validateObject` already answers it.
 */
const SIZING_SENTINELS = new Set(['autosize', 'autocalculate']);

/** @internal */
function isNumericField(definition: SlimType, field: string): boolean {
  const kind = definition.p[field]?.t;
  return kind === 'n' || kind === 'i';
}

/**
 * Whether a string the numeric coercion rejected is legal for this field anyway.
 *
 * Consulted only when coercion has already failed, so the parse path pays nothing for it.
 *
 * @internal
 */
function stringIsLegal(definition: SlimType, field: string, value: string): boolean {
  if (SIZING_SENTINELS.has(value.toLowerCase())) return true;

  const slim = definition.p[field];
  if (slim === undefined) return true;
  // `auto` marks a collapsed `anyOf`. Without an `se` the string branch declared no enum, so any
  // string satisfies it; with one, only its members do.
  if (slim.se === undefined) return slim.auto === 1;

  const folded = value.toLowerCase();
  return slim.se.some((allowed) => allowed.toLowerCase() === folded);
}

/**
 * The 1-based line a field sits on, found by rescanning the statement from its own offset.
 *
 * The lexer records one offset per object rather than a line per field, because a finding about a
 * field is rare and an array per object is not. This is the rescan that offset exists for, and it
 * runs only while a finding is being built.
 *
 * The rescan goes through the shared scanner, so "step over the comment between a separator and
 * its value" is the rule the lexer itself followed rather than a second copy of it. A field's
 * comma is routinely followed by `!- Field Name` on the same line, and a helper that stopped at
 * the `!` would report the line the PREVIOUS value sits on, one too early.
 *
 * `index` counts into `RawObject.values`, which has already had the type name shifted off, so the
 * field wanted is the scanner's `index + 1`: the comma that ends `Building,` is what puts
 * `values[0]` on the line after it. The scan stops at that field, or at the end of the statement
 * when the statement has fewer fields than the finding names, in which case the object's own line
 * is the best answer available.
 *
 * @internal
 */
function fieldLine(text: string, object: RawObject, index: number): number {
  if (object.offset === undefined) return object.line;

  const wanted = index + 1;
  let line = object.line;
  scan(
    text,
    {
      fieldEnd(field, _start, _end, valueLine) {
        if (field < wanted) return;
        line = valueLine;
        return false;
      },
      statementEnd() {
        return false;
      },
    },
    { from: object.offset, line: object.line, column: object.column }
  );
  return line;
}

function coerce(definition: SlimType, field: string, raw: string): StoredValue | undefined {
  return coerceValue(definition.p[field]?.t, raw);
}

function coerceExtensible(
  definition: SlimType,
  field: string,
  raw: string
): string | number | undefined {
  const value = coerceValue(definition.x?.p[field]?.t, raw);
  return Array.isArray(value) ? undefined : value;
}

/**
 * Convert IDF text to a stored value.
 *
 * Numeric fields that hold `Autosize`, `Autocalculate`, or anything else
 * non-numeric stay as strings. EnergyPlus accepts them and silently coercing
 * to `NaN` would destroy the model on write.
 */
function coerceValue(kind: string | undefined, raw: string): StoredValue | undefined {
  if (kind === 'n' || kind === 'i') {
    const parsed = Number(raw);
    if (!Number.isNaN(parsed) && raw.trim() !== '') {
      const value = kind === 'i' ? Math.trunc(parsed) : parsed;
      // Normalize -0 to 0. IDF files do contain `-0`, and JavaScript keeps the
      // sign, so without this a value round-trips to a different (if equal)
      // number and every strict comparison downstream reports a spurious diff.
      return value === 0 ? 0 : value;
    }
  }
  return raw;
}

export class IdfParseError extends Error {
  readonly line: number;
  readonly typeName: string | undefined;
  /**
   * Every finding that stopped the parse.
   *
   * This error carried `line` and `typeName` from a single diagnostic, flattened into fields, and
   * a caller who wanted the rest had nowhere to look. Python's `IDFParseError` has always carried
   * the collection; this is the half of the difference that was real.
   *
   * `line` and `typeName` still resolve to the first finding's values, so no existing caller
   * breaks (FR-013, FR-014). They are a convenience over `diagnostics[0]` rather than a second
   * source of truth.
   */
  readonly diagnostics: readonly ParseDiagnostic[];

  constructor(diagnostic: ParseDiagnostic | readonly ParseDiagnostic[]) {
    const diagnostics = Array.isArray(diagnostic)
      ? (diagnostic as readonly ParseDiagnostic[])
      : [diagnostic as ParseDiagnostic];
    const first = diagnostics[0];
    if (first === undefined) {
      throw new TypeError('IdfParseError needs at least one diagnostic');
    }
    super(`${first.message} (line ${first.line})`);
    this.name = 'IdfParseError';
    this.line = first.line;
    this.typeName = first.typeName;
    this.diagnostics = Object.freeze([...diagnostics]);
  }
}

/**
 * Read the version identifier from IDF text without a schema.
 *
 * Chicken-and-egg: choosing the schema requires knowing the version, and the
 * version lives inside the file. This does the minimum scan needed to break
 * the cycle, and does not validate anything else.
 */
export function getIdfVersion(text: string): string | undefined {
  // Strip comments first. Trying to tolerate them inside the pattern means
  // guessing how many comment lines sit between the comma and the value, which
  // is exactly the kind of thing that works on the file you tested and fails on
  // the next one.
  const stripped = text.replace(/!.*$/gm, '');
  // Anchored to a statement boundary so a field value containing the word
  // "Version" cannot be mistaken for the object.
  const match = /(?:^|;)\s*Version\s*,\s*([\d.]+)\s*;/i.exec(stripped);
  const raw = match?.[1];
  if (raw === undefined) return undefined;
  const parts = raw.split('.').map((p) => Number(p) || 0);
  // EnergyPlus writes `Version, 26.1;` but schemas are keyed `26.1.0`.
  return `${parts[0] ?? 0}.${parts[1] ?? 0}.${parts[2] ?? 0}`;
}
