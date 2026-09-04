import {
  describeObjectType,
  docsUrlForObject,
  type DocsUrl,
  type FieldDescription,
  type ProsePool,
  type Region,
  type Schema,
} from '@idfkit/core';

import { contextAt, type CursorContext } from './cursor.js';

/**
 * What the schema says about whatever the offset is on.
 *
 * Every member is reported rather than composed. The facts come from
 * `describeObjectType`, the prose from the pool the caller supplied, and the manual location from
 * `docsUrlForObject`; nothing here is derived from a field's name, which is the one thing FR-022
 * forbids by name.
 */
export interface Explanation {
  /**
   * The region this explanation describes (FR-049).
   *
   * What a consumer highlights while the explanation is shown, so that the reader can see which
   * characters the words are about. Carried rather than left to the consumer for the reason offers
   * carry theirs: an editor's own word rules split `BuildingSurface:Detailed` at the colon and
   * `Office Zone 1` at the spaces, and would highlight a fragment of each.
   *
   * It identifies a thing rather than something to draw, so it stays whole and may cross a line
   * boundary (FR-050): a field written across two lines is ordinary in this format.
   */
  readonly region: Region;
  /** What the offset is on. */
  readonly of: 'objectType' | 'field';
  /** The canonical type name. */
  readonly typeName: string;
  /** The schema field name, when `of` is `'field'`. */
  readonly fieldName: string | undefined;
  /**
   * The schema's own prose, when the caller supplied the pool.
   *
   * The type's memo for a type name and the field's note for a field. `undefined` where no pool
   * was supplied and where the pool carries none for this record: absence is reported as absence,
   * never filled with a sentence made up from the name.
   */
  readonly prose: string | undefined;
  /**
   * The field's facts, exactly as `describeObjectType` produces them. Undefined for a type name.
   *
   * Also undefined for one field this package cannot describe, and it is worth naming rather than
   * hiding. `describeObjectType` drops the type's positional first field, because Python's
   * `get_field_names` drops it on the assumption that it is always the name. On the anonymous
   * types it is a real field, and `GlobalGeometryRules.starting_vertex_position` is one an author
   * edits by hand. Rebuilding a `FieldDescription` here would be a second copy of the schema's
   * facts, which FR-029 forbids and which would drift from the reference page the reader is
   * comparing against, so the structural facts are reported as absent and the field's own prose is
   * still resolved. Closing the hole properly means changing `describeObjectType` in
   * `@idfkit/core`, which this package does not own.
   */
  readonly field: FieldDescription | undefined;
  /**
   * Where the manual documents this, from `docsUrlForObject`.
   *
   * The type's page in both cases, because that is where the manual documents a field: it has no
   * page of its own. `undefined` for a version the documentation site does not carry.
   */
  readonly docs: DocsUrl | undefined;
}

/**
 * What the schema says here, or why it says nothing.
 *
 * The same discriminated shape as `CompletionResult`, for the same reason: "there is nothing here
 * to explain" and "I could not consult a schema" are different states, and an editor that rendered
 * them identically would teach the reader that the tool is broken in the first case and silently
 * wrong in the second (FR-031).
 */
export type ExplanationResult =
  | { readonly status: 'ok'; readonly explanation: Explanation }
  | { readonly status: 'noSchema' }
  | { readonly status: 'unknownType'; readonly typeName: string }
  | { readonly status: 'notApplicable' };

const NOT_APPLICABLE: ExplanationResult = { status: 'notApplicable' };
const NO_SCHEMA: ExplanationResult = { status: 'noSchema' };

/**
 * What the thing under the cursor means, in the schema's own words.
 *
 * Bounded local work, like every other cursor answer: the cursor is placed by {@link contextAt},
 * which scans one statement, and the answer then comes from the type, whose cost is the type
 * rather than the file.
 *
 * The prose pool stays the caller's to load (FR-028). It is a parameter rather than something
 * reached for, and this module imports it as a type alone, so a caller who never asks for prose
 * never pays for it: passing nothing yields the structural facts with `prose: undefined`, which is
 * a truthful absence rather than a sentence derived from the field's name.
 *
 * `schema` is written as possibly absent rather than required, because `'noSchema'` is a state
 * FR-031 requires this to report and a signature that forbade the input would make it unreachable
 * from typed code.
 *
 * Nothing throws, for any input.
 */
export function explainAt(
  text: string,
  offset: number,
  schema: Schema | undefined,
  prose?: ProsePool
): ExplanationResult {
  const context = contextAt(text, offset, schema);

  // Inside a comment, and in the whitespace between two statements, there is nothing the schema
  // has anything to say about. Reporting `'noSchema'` here would send a caller off to load one
  // that would change this answer not at all.
  if (context.at === 'comment' || context.at === 'betweenStatements') return NOT_APPLICABLE;
  if (schema === undefined) return NO_SCHEMA;

  // The region first, and the schema afterwards. An offset on a separator, on a terminator, or in
  // the whitespace beside a value falls outside every region this statement holds, and answering
  // it with the nearest field is the behaviour that makes a hover feel haunted (FR-049). The test
  // is containment rather than a character test, because a region already ends where the value
  // ends: it begins at the value's first non-blank character and stops after its last, so
  // everything between two values, the comma included, is outside both.
  const at = clampOffset(offset, text.length);
  const region = describedRegion(context, at);
  if (region === undefined) return NOT_APPLICABLE;

  const typeName = context.typeName;
  if (typeName === undefined) {
    return { status: 'unknownType', typeName: context.statement.typeNameText };
  }
  const type = schema.get(typeName);
  // Unreachable through `resolve`, which only returns a name the schema holds, and kept because
  // `describeObjectType` throws on a type the schema lacks and nothing here may throw (FR-030).
  if (type === undefined) return { status: 'unknownType', typeName };

  const described = describeObjectType(schema, typeName, prose);
  const docs = docsUrlForObject(typeName, schema.version, schema);

  if (context.at === 'typeName') {
    return {
      status: 'ok',
      explanation: {
        region,
        of: 'objectType',
        typeName,
        fieldName: undefined,
        prose: described.memo,
        field: undefined,
        docs,
      },
    };
  }

  const fieldName = context.fieldName;
  // Past the type's last field, with no extensible group to repeat. The schema defines no field
  // here and so says nothing about one; that the field should not be there is a finding, and
  // saying so is that finding's job rather than this one's.
  if (fieldName === undefined) return NOT_APPLICABLE;

  const field = described.fields.find((candidate) => candidate.name === fieldName);
  return {
    status: 'ok',
    explanation: {
      region,
      of: 'field',
      typeName,
      fieldName,
      // `field.note` is the same lookup, and taking it from the description keeps one source for
      // it. The fallback is the pool lookup for the one field the description cannot carry, which
      // resolves an index the schema already holds rather than reproducing anything.
      prose: field === undefined ? proseFor(type.p[fieldName]?.n, prose) : field.note,
      field,
      docs,
    },
  };
}

/**
 * The region the explanation is about, or `undefined` when the offset is not on one.
 *
 * `at` is `'typeName'` or `'field'` by the time this is called, so the region is the statement's
 * type name or the written field at the cursor's index. A field written empty has an empty region
 * positioned between its separators, which contains no offset at all, and that is the right answer
 * for it: there is no text there to explain.
 */
function describedRegion(context: CursorContext, offset: number): Region | undefined {
  const region =
    context.at === 'typeName'
      ? context.statement.typeName
      : // `fieldIndex` is defined for every `'field'` context; the guard is what the compiler
        // needs, and an offset on no field is not on a region either way.
        context.statement.fields[context.fieldIndex ?? -1];
  if (region === undefined) return undefined;
  return offset >= region.start && offset < region.end ? region : undefined;
}

/** Resolve a prose index against the pool. Nothing is hydrated when no pool was supplied. */
function proseFor(index: number | undefined, prose: ProsePool | undefined): string | undefined {
  if (index === undefined || prose === undefined) return undefined;
  return prose[index];
}

/**
 * Into `[0, max]`, whole. `NaN` lands at 0, since no position is nearer than another.
 *
 * The clamp `contextAt` applies (FR-032), repeated because it is private to the cursor module. A
 * containment test measured against an unclamped offset would disagree with the context it is
 * testing, and would report nothing for an offset a keystroke past the end of the text where the
 * cursor answer describes the last character.
 */
function clampOffset(value: number, max: number): number {
  if (Number.isNaN(value)) return 0;
  const whole = Math.trunc(value);
  if (whole < 0) return 0;
  return whole > max ? max : whole;
}
