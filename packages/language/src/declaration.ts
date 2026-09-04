import {
  describeObjectType,
  type IdfDocument,
  type Region,
  type Schema,
  type SlimType,
} from '@idfkit/core';

import { contextAt } from './cursor.js';

/** Where one object declares the name the cursor is on. */
export interface Declaration {
  /**
   * The region where the name is declared, meaning the name field of the declaring statement.
   *
   * A region in the text this was asked about, not in the document: the document holds no
   * positions, and it is the text the reader is looking at. It identifies a thing rather than
   * something to draw, so it stays whole and may cross a line boundary (FR-050).
   */
  readonly region: Region;
  /** The declaring statement's canonical type. */
  readonly typeName: string;
}

/**
 * What the value under the cursor names, or why it names nothing.
 *
 * The same discriminated shape as `CompletionResult`, for the same reason: "this value names
 * nothing that exists" and "I could not consult a schema" are different states, and a consumer
 * that wants to tell a reader why nothing happened has the reason (FR-031).
 *
 * `'ok'` with no declarations is a legitimate state and a different one from all three below: it
 * says the field points into a reference list and nothing in the document declares this name.
 * Where the name is declared nowhere, none is reported and none is guessed at; the
 * dangling-reference finding is what tells the reader why.
 */
export type DeclarationResult =
  | { readonly status: 'ok'; readonly declarations: readonly Declaration[] }
  | { readonly status: 'noSchema' }
  | { readonly status: 'unknownType'; readonly typeName: string }
  | { readonly status: 'notApplicable' };

const NOT_APPLICABLE: DeclarationResult = { status: 'notApplicable' };
const NO_SCHEMA: DeclarationResult = { status: 'noSchema' };
const NONE: DeclarationResult = { status: 'ok', declarations: [] };

/**
 * Where the name under the cursor is declared.
 *
 * Two steps, and keeping them apart is what keeps this honest. Which objects declare the name is
 * resolved against the caller's document, by the two rules the model itself uses and no third one
 * (FR-029): the object's own name, when its type's `nref` contributes to a list this field points
 * into, and an ordinary field's value, when that field's `ref` does. Only then is the declaring
 * statement located in the text, by looking for the name the document holds and confirming with a
 * cursor context that the match really is that type's declaring field. So the text is never
 * searched for a string that happens to match: it is searched for a name the document has already
 * said is declared, and a match that turns out to be a value somewhere else is discarded.
 *
 * The document is the caller's, exactly as it is for reference completion, and for the same reason
 * (research R9): declarations are a whole-document fact, every consumer already holds a document,
 * and parsing one here would put the eighty milliseconds this design exists to avoid back on the
 * keystroke path. A document a keystroke behind the text is the correct input rather than a stale
 * one.
 *
 * **Honest bound.** Locating a declaration reads the text rather than one statement of it, because
 * "every declaration" is a question about the whole file and cannot be answered from a bounded
 * local scan. The reading is `String.prototype.indexOf`, a native scan of a few hundred kilobytes
 * costing a small fraction of a millisecond, plus one bounded cursor context per candidate match,
 * and no layer is built and no document is parsed. It is stated here rather than left for a reader
 * to discover in a profile.
 *
 * `schema` is written as possibly absent rather than required, because `'noSchema'` is a state
 * FR-031 requires this to report and a signature that forbade the input would make it unreachable
 * from typed code.
 *
 * Nothing throws, for any input.
 */
export function declarationAt(
  text: string,
  offset: number,
  schema: Schema | undefined,
  document: IdfDocument
): DeclarationResult {
  const context = contextAt(text, offset, schema);

  // A type name declares nothing and names nothing, a comment holds no values, and between two
  // statements there is no value to follow. Reporting `'noSchema'` in a comment would send a
  // caller off to load one that would change this answer not at all.
  if (context.at !== 'field') return NOT_APPLICABLE;
  if (schema === undefined) return NO_SCHEMA;

  const typeName = context.typeName;
  if (typeName === undefined) {
    return { status: 'unknownType', typeName: context.statement.typeNameText };
  }
  const type = schema.get(typeName);
  // Unreachable through `resolve`, which only returns a name the schema holds, and kept because
  // `describeObjectType` throws on a type the schema lacks and nothing here may throw (FR-030).
  if (type === undefined) return { status: 'unknownType', typeName };

  const index = context.fieldIndex;
  const fieldName = context.fieldName;
  // No field index on a `'field'` context is unreachable, and a field the type does not define is
  // ordinary: a statement may carry more fields than its type has.
  if (index === undefined || fieldName === undefined) return NOT_APPLICABLE;

  const lists = listsPointedInto(schema, typeName, type, fieldName);
  // The field points at nothing. Searching the document for an object that happens to be called
  // whatever is written here would find one often enough to be believed and would be a guess.
  if (lists.length === 0) return NOT_APPLICABLE;

  const written = context.statement.fields[index];
  const target = written === undefined ? '' : text.slice(written.start, written.end);
  // A field left empty names nothing, which is the same answer as a name nothing declares.
  if (target === '') return NONE;

  const declarations: Declaration[] = [];
  const seen = new Set<number>();
  for (const declared of declaringObjects(document, schema, new Set(lists), fold(target))) {
    const region = locate(text, schema, declared);
    if (region === undefined || seen.has(region.start)) continue;
    seen.add(region.start);
    declarations.push({ region, typeName: declared.typeName });
  }
  return { status: 'ok', declarations };
}

/**
 * The reference lists a field points into, taken from `describeObjectType` (FR-029).
 *
 * With the one hole `completionsAt` documents at length: `describeObjectType` drops the type's
 * positional first field, which on an anonymous type is a real field, so that one is read from its
 * own record. Reading `ol` is the same key the description reports and not a second opinion about
 * it.
 */
function listsPointedInto(
  schema: Schema,
  typeName: string,
  type: SlimType,
  fieldName: string
): readonly string[] {
  const described = describeObjectType(schema, typeName).fields.find(
    (field) => field.name === fieldName
  );
  if (described !== undefined) return described.objectList ?? [];
  return type.p[fieldName]?.ol ?? [];
}

/** One object that declares the name, and where in its statement the declaration is written. */
interface DeclaringObject {
  /** The declaring object's canonical type name. */
  readonly typeName: string;
  /** Positional index of the field that declares the name, counted as `CursorContext` counts. */
  readonly fieldIndex: number;
  /** The name as the document holds it, which is the casing the text wrote it in. */
  readonly text: string;
}

/**
 * The objects declaring `folded` into one of `wanted`.
 *
 * The two ways a name reaches a reference list, and no third one (FR-029). Both are read, because
 * the second is how anonymous types such as `FluidProperties:Name` carry their identity, and
 * treating those as nameless would report nothing where the model plainly declares something.
 *
 * Membership of the lists the field points into is what makes a match a declaration rather than a
 * coincidence. A `Zone` and a `Construction` may both be called `Office`, and following a
 * construction name to the zone would be the guess this function exists to avoid. It is why a name
 * declared only into some other list reports none here while the validator's dangling check, which
 * asks the coarser question of whether any object declares the name at all, stays quiet: this
 * reports what the field can name, not what the file happens to contain.
 *
 * Names are compared case-insensitively, the way EnergyPlus resolves them and the way every other
 * name comparison in this library does.
 */
function declaringObjects(
  document: IdfDocument,
  schema: Schema,
  wanted: ReadonlySet<string>,
  folded: string
): DeclaringObject[] {
  const out: DeclaringObject[] = [];

  for (const object of document.objects()) {
    const canonical = schema.resolve(object.typeName) ?? object.typeName;
    const type = schema.get(canonical);
    if (type === undefined) continue;

    const nameIndex = type.f.indexOf('name');
    if (
      nameIndex >= 0 &&
      object.name !== '' &&
      fold(object.name) === folded &&
      contributes(type.nref, wanted)
    ) {
      out.push({ typeName: canonical, fieldIndex: nameIndex, text: object.name });
    }

    for (const [field, definition] of Object.entries(type.p)) {
      if (!contributes(definition.ref, wanted)) continue;
      const value = object.get(field);
      if (typeof value !== 'string' || value === '' || fold(value) !== folded) continue;
      const fieldIndex = type.f.indexOf(field);
      if (fieldIndex < 0) continue;
      out.push({ typeName: canonical, fieldIndex, text: value });
    }
  }
  return out;
}

/** Whether any list this record contributes to is one the field points into. */
function contributes(
  declared: readonly string[] | undefined,
  wanted: ReadonlySet<string>
): boolean {
  if (declared === undefined) return false;
  return declared.some((list) => wanted.has(list));
}

/**
 * The region in the text where this object writes the name it declares.
 *
 * Every occurrence of the name is a candidate and a cursor context decides each one: the match
 * must be a field, of the declaring type, at the declaring field's index, and the field's whole
 * text must be the name rather than a value containing it, so `Office` never resolves to
 * `Office Zone 2`. The first survivor is the answer, because a document cannot hold two objects of
 * one type sharing a name: `IdfDocument.addRaw` throws on the second and `parseIdf` records a
 * `ParseError` and skips it, which is the same fact the finding correlation rests on (research
 * R6).
 *
 * The comparison is exact rather than folded because the string being looked for came out of the
 * document, which stores a value as the text wrote it, trimmed and with comments stripped. The one
 * case that misses is a name interrupted by a comment between two of its words, which the reader
 * joins and the syntax layer does not; that declaration is then reported as unlocatable rather
 * than as a region on the wrong characters.
 */
function locate(text: string, schema: Schema, declared: DeclaringObject): Region | undefined {
  for (
    let from = text.indexOf(declared.text);
    from >= 0;
    from = text.indexOf(declared.text, from + 1)
  ) {
    const context = contextAt(text, from, schema);
    if (context.at !== 'field' || context.fieldIndex !== declared.fieldIndex) continue;
    if (context.typeName !== declared.typeName) continue;
    const region = context.statement.fields[declared.fieldIndex];
    if (region === undefined) continue;
    if (text.slice(region.start, region.end) !== declared.text) continue;
    return region;
  }
  return undefined;
}

/** Case-insensitive name comparison, as EnergyPlus resolves names. */
function fold(value: string): string {
  return value.toLowerCase();
}
