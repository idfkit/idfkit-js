import {
  describeObjectType,
  type IdfDocument,
  type ProsePool,
  type Region,
  type Schema,
  type SlimField,
  type SlimType,
} from '@idfkit/core';

import { contextAt, fieldNameAt, type CursorContext } from './cursor.js';

/**
 * One thing that may go where the cursor is.
 *
 * Everything a consumer needs to render the offer and to apply it, so that a list can be shown and
 * accepted without a second call and without the consumer measuring anything itself.
 */
export interface Offer {
  /** The text to insert. */
  readonly value: string;
  /**
   * The region this offer would replace.
   *
   * Carried rather than left to the consumer (FR-048), and this is not optional politeness. An
   * editor's own word rules break on both halves of this format: type names contain colons, so
   * `BuildingSurface:Detailed` is two words to most of them, and values contain spaces, so
   * `Office Zone 1` is three. A consumer left to derive the replaced span would get it wrong on
   * the majority of real completions. Working it out needs the format's rules, which live here.
   *
   * The region is empty where nothing has been written yet, which is an insertion at that point.
   */
  readonly replaces: Region;
  /** What kind of thing this is. */
  readonly kind: 'objectType' | 'enumValue' | 'referenceTarget';
  /** Whether the schema marks the field required. Undefined for object types. */
  readonly required: boolean | undefined;
  /**
   * The schema's own prose, when the caller supplied the pool.
   *
   * The type's memo for a type-name offer and the field's note for a value offer, because those
   * are the two things the pool holds. It carries no sentence about an individual permitted value
   * and neither does this: deriving one from the value's spelling is the one thing FR-022 forbids
   * by name.
   */
  readonly prose: string | undefined;
}

/**
 * What completes here, or why nothing does.
 *
 * A discriminated union rather than a list that is sometimes empty, because "the schema permits
 * anything here" and "I could not consult a schema" are different states and an editor that
 * rendered them identically would teach the reader that the tool is broken in the first case and
 * silently wrong in the second (FR-020, FR-031). A consumer that only wants the happy path matches
 * `'ok'` and ignores the rest; a consumer that wants to tell a reader why there is nothing has the
 * reason.
 *
 * `'ok'` with no offers is a legitimate state and a different one from all four below: it says the
 * schema constrains this field to names the model has not declared yet.
 */
export type CompletionResult =
  | { readonly status: 'ok'; readonly offers: readonly Offer[] }
  | { readonly status: 'unconstrained' }
  | { readonly status: 'noSchema' }
  | { readonly status: 'unknownType'; readonly typeName: string }
  | { readonly status: 'notApplicable' };

/** What a caller can supply beyond the text, the offset and the schema. */
export interface CompletionOptions {
  /** Supplies candidate names for reference fields. Omit and none are offered. */
  readonly document?: IdfDocument;
  /** Supplies prose for the offers. Omit and offers carry none. */
  readonly prose?: ProsePool;
}

const NOT_APPLICABLE: CompletionResult = { status: 'notApplicable' };
const NO_SCHEMA: CompletionResult = { status: 'noSchema' };
const UNCONSTRAINED: CompletionResult = { status: 'unconstrained' };

/**
 * What may be written where the cursor is.
 *
 * Bounded local work: the cursor is placed by {@link contextAt}, which scans one statement, and
 * the answer then comes from the schema, whose cost is the type rather than the file. The one
 * exception is a reference field, whose candidates are the names other objects declare, which is a
 * whole-document question by nature; it is answered from the document the caller already holds and
 * never by parsing one (research R9). A service that quietly parsed a document when the argument
 * was omitted would make one function on the keystroke path eighty milliseconds slower depending
 * on an argument nobody passed, which is the worst failure mode available.
 *
 * The whole schema's type list is offered where a statement begins, unfiltered by what has been
 * typed so far. Filtering is the consumer's, and it has what it needs to do it: `replaces` says
 * exactly which characters the offer stands in for, which is the span an editor's own word rules
 * get wrong on this format.
 *
 * `schema` is written as possibly absent rather than required, because `'noSchema'` is a state
 * FR-031 requires this to report and a signature that forbade the input would make it unreachable
 * from typed code.
 *
 * Nothing throws, for any input.
 */
export function completionsAt(
  text: string,
  offset: number,
  schema: Schema | undefined,
  options: CompletionOptions = {}
): CompletionResult {
  const context = contextAt(text, offset, schema);

  // Inside a comment nothing completes, with a schema or without one. Reporting `'noSchema'` here
  // would send a caller off to load one that would change this answer not at all.
  if (context.at === 'comment') return NOT_APPLICABLE;
  if (schema === undefined) return NO_SCHEMA;

  // `'typeName'` and `'betweenStatements'` are the two states that carry no field index, and both
  // are a statement beginning: half a type name written, or nothing written yet.
  if (context.fieldIndex === undefined) {
    return { status: 'ok', offers: typeNameOffers(schema, context, options.prose) };
  }

  const typeName = context.typeName;
  if (typeName === undefined) {
    return { status: 'unknownType', typeName: context.statement.typeNameText };
  }
  const type = schema.get(typeName);
  if (type === undefined) return { status: 'unknownType', typeName };

  const facts = fieldFactsAt(schema, typeName, type, context.fieldIndex, options.prose);
  // Past the type's last field, with no extensible group to repeat. The schema constrains a field
  // it does not define in no way at all; that the field should not be there is a finding, and
  // saying so is that finding's job rather than this one's.
  if (facts === undefined) return UNCONSTRAINED;

  const written = context.statement.fields[context.fieldIndex];
  // A field index is counted from the separators of this same statement, so it always names a
  // written field. An insertion at the statement's end is the harmless answer if that ever stops
  // being true; replacing the statement's whole region would not be.
  const replaces: Region = written ?? {
    start: context.statement.region.end,
    end: context.statement.region.end,
  };

  if (facts.values !== undefined && facts.values.length > 0) {
    return {
      status: 'ok',
      offers: facts.values.map((value) => ({
        // Numeric on the handful of fields that express a choice numerically, and the offer is
        // text to insert, so it is spelled the way it would be written.
        value: String(value),
        replaces,
        kind: 'enumValue',
        required: facts.required,
        prose: facts.prose,
      })),
    };
  }

  if (facts.objectList !== undefined && facts.objectList.length > 0) {
    const document = options.document;
    // No document, so no candidates can exist. Saying so is the point: an empty `'ok'` list here
    // would be indistinguishable from a model that has declared nothing yet.
    if (document === undefined) return NOT_APPLICABLE;
    return {
      status: 'ok',
      offers: declaredNames(document, schema, facts.objectList).map((value) => ({
        value,
        replaces,
        kind: 'referenceTarget',
        required: facts.required,
        prose: facts.prose,
      })),
    };
  }

  return UNCONSTRAINED;
}

/**
 * Every object type the schema defines, as offers replacing the type name as written.
 *
 * The replaced region is the statement's type name, which is empty where nothing has been typed
 * yet, so accepting an offer between two statements inserts and accepting one over a half-written
 * name replaces the whole of it, colons included.
 */
function typeNameOffers(
  schema: Schema,
  context: CursorContext,
  prose: ProsePool | undefined
): Offer[] {
  const replaces = context.statement.typeName;
  return schema.typeNames.map((value) => ({
    value,
    replaces,
    kind: 'objectType',
    // A type is not required or optional; only a field is.
    required: undefined,
    prose: memoOf(schema, value, prose),
  }));
}

/**
 * The names objects in this document declare into any of `lists`.
 *
 * A walk of the document the caller handed in, which is a document cost rather than a text cost:
 * nothing is parsed, nothing is scanned, and a document a keystroke behind the text is the correct
 * input rather than a stale one, because the statement being typed is incomplete by definition and
 * names harvested from it would be garbage (research R9).
 *
 * A name reaches a list two ways, and both are read here so that no third way to resolve a name is
 * invented (FR-029): the object's own name, when its type's `nref` contributes to the list, and an
 * ordinary field's value, when that field's `ref` does. The second is how anonymous types such as
 * `FluidProperties:Name` carry their identity, and treating those as nameless would offer nothing
 * where the model plainly declares something.
 */
function declaredNames(document: IdfDocument, schema: Schema, lists: readonly string[]): string[] {
  const wanted = new Set(lists);
  const seen = new Set<string>();
  const names: string[] = [];

  const keep = (value: string | undefined): void => {
    if (value === undefined || value === '') return;
    // Deduplicated case-insensitively, the way EnergyPlus resolves a name, but offered in the
    // casing the model wrote it in, which is what a reader expects to see inserted.
    const key = value.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    names.push(value);
  };

  for (const object of document.objects()) {
    const type = schema.get(object.typeName);
    if (type === undefined) continue;
    if (contributes(type.nref, wanted)) keep(object.name);
    for (const [field, definition] of Object.entries(type.p)) {
      if (!contributes(definition.ref, wanted)) continue;
      const value = object.get(field);
      if (typeof value === 'string') keep(value);
    }
  }
  return names;
}

/** Whether any list this record contributes to is one the field points into. */
function contributes(
  declared: readonly string[] | undefined,
  wanted: ReadonlySet<string>
): boolean {
  if (declared === undefined) return false;
  return declared.some((list) => wanted.has(list));
}

/** The facts an offer needs about the field the cursor is in. */
interface FieldFacts {
  /** Permitted values, when the field is a choice. */
  readonly values: readonly (string | number)[] | undefined;
  /** Reference lists this field points into. */
  readonly objectList: readonly string[] | undefined;
  /** Whether the schema marks the field required. */
  readonly required: boolean;
  /** The field's own note, resolved when a pool was supplied. */
  readonly prose: string | undefined;
}

/**
 * What the schema says about the field at a positional index.
 *
 * Taken from `describeObjectType`, which is the one place a field's facts are read (FR-029), so
 * that a completion offers what the reference page documents rather than a second opinion about
 * the same bundle.
 *
 * With one hole, and it is worth naming rather than hiding. `describeObjectType` drops the type's
 * positional first field, because Python's `get_field_names` drops it on the assumption that it is
 * always the name. On a named type it is, and the name is free text, so `'unconstrained'` is the
 * right answer there anyway. On the 164 anonymous types it is a real field, and 41 of those are
 * choice fields: `GlobalGeometryRules.starting_vertex_position` is one an author edits by hand.
 * Reporting nothing for those would be silently wrong, so this reads that one field's record
 * directly. Closing the hole properly means changing `describeObjectType` in `@idfkit/core`, which
 * this package does not own.
 */
function fieldFactsAt(
  schema: Schema,
  typeName: string,
  type: SlimType,
  index: number,
  prose: ProsePool | undefined
): FieldFacts | undefined {
  const name = fieldNameAt(type, index);
  if (name === undefined) return undefined;

  const described = describeObjectType(schema, typeName, prose).fields.find(
    (field) => field.name === name
  );
  if (described !== undefined) {
    return {
      values: described.enumValues,
      objectList: described.objectList,
      required: described.required,
      prose: described.note,
    };
  }

  const definition = type.p[name] ?? type.x?.p[name];
  if (definition === undefined) return undefined;
  return {
    values: permittedValues(definition),
    objectList: definition.ol,
    required: (type.r ?? []).includes(name),
    prose: definition.n === undefined ? undefined : prose?.[definition.n],
  };
}

/**
 * The values a field accepts, for the one field `describeObjectType` cannot describe.
 *
 * Reproduces that function's `acceptedValues` exactly, and only exists because it is not reachable
 * from here. `se`, the collapsed `anyOf` string branch, carries the sizing sentinels and wins when
 * it is present; `e`, the choice list, has had the empty string filtered out by the bundle because
 * `e` is what validation checks against, and `eb` records that it was there.
 */
function permittedValues(field: SlimField): (string | number)[] | undefined {
  if (field.se !== undefined) return [...field.se];
  if (field.e === undefined) return undefined;
  return field.eb === 1 ? ['', ...field.e] : [...field.e];
}

/** A type's own prose, resolved against the pool. Nothing is hydrated when no pool was supplied. */
function memoOf(
  schema: Schema,
  typeName: string,
  prose: ProsePool | undefined
): string | undefined {
  if (prose === undefined) return undefined;
  const memo = schema.get(typeName)?.m;
  return memo === undefined ? undefined : prose[memo];
}
