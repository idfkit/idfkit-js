import { offsetAt, parseIdf, scanIdf, validateDocument } from '@idfkit/core';
import type {
  ParseDiagnostic,
  Region,
  Schema,
  SlimType,
  Statement,
  SyntaxLayer,
  ValidationError,
} from '@idfkit/core';

/**
 * An existing finding with the region it concerns attached. Not a new finding.
 *
 * `F` stays whatever it was: a `ParseDiagnostic` or a `ValidationError`, unchanged, with two
 * properties added beside it. The generic is what lets both travel through one path without either
 * type being touched, which is the whole point of correlating here rather than at the source. FR-014
 * forbids filtering or rewording a finding and FR-015 forbids changing what an existing caller
 * receives; both hold structurally, because nothing on the read path knows this module exists.
 */
export type PositionedFinding<F> = F & {
  /** The region the finding concerns. */
  readonly region: Region;
  /** Whether the region selects the field or falls back to the statement. */
  readonly precision: 'field' | 'statement';
};

/**
 * Read text, validate what it produced, and position every finding from both.
 *
 * One parse, one validation, one scan, in that order, and then the correlation below. A consumer
 * that already holds findings from its own run should call {@link position} instead and keep its
 * parse; this exists for the consumer that has only text.
 *
 * Reading findings come first and validation findings after, which is the order in which the two
 * runs produced them. Neither list is filtered: a value that is both unreadable and invalid is two
 * findings here because it was two findings before.
 *
 * @example
 * ```ts
 * for (const finding of findingsIn(text, schema)) {
 *   const { line, column } = lineColumnAt({ text }, finding.region.start);
 *   console.log(`${line}:${column}`, finding.message);
 * }
 * ```
 */
export function findingsIn(
  text: string,
  schema: Schema
): readonly PositionedFinding<ParseDiagnostic | ValidationError>[] {
  // Never strict: a strict read throws on the first finding, and a caller asking for every finding
  // in a file is asking for the file to be described rather than rejected.
  const { document, diagnostics } = parseIdf(text, schema, { strict: false });
  const validation = validateDocument(document);
  const findings: (ParseDiagnostic | ValidationError)[] = [
    ...diagnostics,
    ...validation.errors,
    ...validation.warnings,
    ...validation.info,
  ];
  return position(findings, scanIdf(text), schema);
}

/**
 * Attach a region to each of a set of findings already produced.
 *
 * Exposed separately from {@link findingsIn} so a consumer holding findings from its own parse and
 * its own validation pays for one scan rather than for a second read of the same text.
 *
 * Two families of finding arrive here and they are positioned by different routes, because they
 * know different things. A reading finding was made by the scanner and already names a line, and
 * often a column, so it is placed directly at what the scanner saw. A validation finding was made
 * from a document and names an object by type and name, never a place, so it is correlated against
 * the statement index below.
 *
 * A finding of neither shape, or one naming something this text does not contain, still comes back
 * with a region: an empty one at the start of the text, saying as little as is actually known. SC-004
 * asks for a region on every finding and zero omitted, and dropping the ones that were hard would
 * satisfy the count while defeating the point.
 *
 * Findings are returned in the order they were given, so a caller can zip the result against its
 * own list.
 */
export function position<F extends object>(
  findings: readonly F[],
  layer: SyntaxLayer,
  schema: Schema
): readonly PositionedFinding<F>[] {
  // Built per call rather than cached against the layer: it costs one pass over the statements and
  // a couple of string operations each, against a parse and a validation run that have already
  // happened. A cache here would be state, and this package holds none.
  const index = indexStatements(layer, schema);
  return findings.map((finding) => {
    const placed = isValidationShaped(finding)
      ? placeValidation(finding, occurrenceOf(finding), schema, index)
      : isParseShaped(finding)
        ? placeParse(finding, layer)
        : undefined;
    return {
      ...finding,
      region: placed?.region ?? NOWHERE,
      precision: placed?.precision ?? 'statement',
    };
  });
}

/** A region and how precisely it answers, before it is attached to a finding. */
interface Placement {
  readonly region: Region;
  readonly precision: 'field' | 'statement';
}

/**
 * Where a finding lands when nothing in the text answers to it.
 *
 * Empty and at the start, which is what an editor renders as a file-level diagnostic. A region
 * covering the whole text would be a claim about where the problem is, and there is no such claim
 * to make.
 */
const NOWHERE: Region = { start: 0, end: 0 };

/**
 * What a finding may carry to say WHICH occurrence it concerns, when its own type cannot.
 *
 * Neither property exists on `ValidationError` today and nothing in `@idfkit/core` produces one, so
 * neither is required and neither is exported: a caller that knows more than the finding does
 * passes `ValidationError & { readonly index: number }` and this reads it. They are declared rather
 * than read out of thin air because both are answers to real gaps, and both are spelled the way the
 * library already spells them.
 *
 * `index` is `ReferenceEdge.index`, the repeat within an extensible group, and it is the only way
 * to tell the ninth vertex of a surface from the first: a `ValidationError` naming
 * `vertex_x_coordinate` names the field and not the repeat. `ordinal` is the position of an
 * anonymous object among the statements of its type, which `objName` cannot carry because it is
 * documented as empty for exactly those objects.
 */
interface Occurrence {
  /** Position of the object among the statements of its type, counting from zero. */
  readonly ordinal?: number;
  /** Repeat within the extensible group, counting from zero, when the field lives in one. */
  readonly index?: number;
}

/**
 * Statements indexed twice, both in source order, which is how a finding reaches a place.
 *
 * The name key is unambiguous, and that is not obvious: duplicate names are common in real files,
 * so keying on one looks unsafe. It is safe because `IdfDocument.addRaw` throws when a second
 * object of a type carries an existing name, `parseIdf` catches that, records a `ParseError`, and
 * skips the object. A document parsed from text therefore never holds two objects sharing a folded
 * type and a folded name, so no validation finding can be about the second one. The duplicate
 * reaches the reader as a reading finding instead, positioned by the scanner that saw it, and never
 * arrives here at all. `packages/core/tests/document.test.ts` asserts that rather than trusting it.
 *
 * The ordinal key is sound because `parseIdf` adds in source order and `IdfCollection` preserves
 * insertion order and documents that it does, so the Nth object of a type in the document is the
 * Nth statement of that type in the text. That is asserted in the same file, for the same reason.
 */
interface StatementIndex {
  /** Folded type name and folded object name, for named objects. */
  readonly byName: ReadonlyMap<string, Statement>;
  /** Folded type name to the statements of that type, in source order, for anonymous ones. */
  readonly byOrdinal: ReadonlyMap<string, readonly Statement[]>;
}

function indexStatements(layer: SyntaxLayer, schema: Schema): StatementIndex {
  const byName = new Map<string, Statement>();
  const byOrdinal = new Map<string, Statement[]>();
  // The schema hydrates a definition on every `get`, and a file holds thousands of statements of a
  // few hundred types, so the answer to "is this type named?" is worth keeping.
  const named = new Map<string, boolean>();

  for (const statement of layer.statements) {
    const type = fold(statement.typeNameText);

    let ofType = byOrdinal.get(type);
    if (ofType === undefined) {
      ofType = [];
      byOrdinal.set(type, ofType);
    }
    ofType.push(statement);

    let isNamed = named.get(type);
    if (isNamed === undefined) {
      isNamed = schema.get(statement.typeNameText)?.anon !== 1;
      named.set(type, isNamed);
    }
    if (!isNamed) continue;

    // The name is the first field after the type name, which is what `Statement.fields` indexes
    // from zero and what `parseIdf` reads the object's name out of.
    const written = statement.fields[0];
    if (written === undefined) continue;
    const key = nameKey(type, fold(layer.text.slice(written.start, written.end).trim()));
    // First occurrence wins, matching `addRaw`: the object the document kept is the first one
    // written, so a finding about this type and name is a finding about this statement.
    if (!byName.has(key)) byName.set(key, statement);
  }

  return { byName, byOrdinal };
}

// ---------------------------------------------------------------------------
// Validation findings, which name an object and are correlated
// ---------------------------------------------------------------------------

function placeValidation(
  finding: ValidationError,
  occurrence: Occurrence,
  schema: Schema,
  index: StatementIndex
): Placement | undefined {
  const statement = correlate(finding, occurrence, index);
  if (statement === undefined) return undefined;

  // A finding with no field concerns the object itself: an unknown type, a singleton written twice.
  // It selects the type name, which is the part of the statement that identifies it and the only
  // part short enough to underline.
  if (finding.field === undefined) {
    return { region: statement.typeName, precision: 'statement' };
  }

  const type = schema.get(finding.objType);
  const at = type === undefined ? undefined : fieldIndexOf(type, finding.field, occurrence.index);
  // A field the schema does not define, or one whose repeat the finding could not say, falls back
  // to the whole statement and says so. Guessing a position for it would put an underline under a
  // value that is not the one complained about, which reads as correct and is not.
  if (at === undefined) return { region: statement.region, precision: 'statement' };

  const region = statement.fields[at];
  // Past what was written: the field is absent from the text, which is exactly what a missing
  // required field is. There is nothing to select, so the statement stands in.
  if (region === undefined) return { region: statement.region, precision: 'statement' };

  // A field written blank keeps an empty region between its two commas, and that is still the right
  // place: it is where the value would have gone, and where an editor puts the caret to type it.
  return { region, precision: 'field' };
}

/** The statement a validation finding is about, by name when it has one and by ordinal when it does not. */
function correlate(
  finding: ValidationError,
  occurrence: Occurrence,
  index: StatementIndex
): Statement | undefined {
  const type = fold(finding.objType);
  if (finding.objName !== '') {
    const named = index.byName.get(nameKey(type, fold(finding.objName)));
    if (named !== undefined) return named;
  }
  const ofType = index.byOrdinal.get(type);
  if (ofType === undefined) return undefined;
  // `objName` is documented as empty for anonymous objects, which is the signal to use the ordinal.
  // The finding does not carry one, so a caller that knows it supplies it and everything else lands
  // on the first statement of the type. That is exact for the singletons nearly every anonymous
  // type is, and it is the closest available answer for the few that are not.
  return ofType[occurrence.ordinal ?? 0];
}

/**
 * The positional index a schema field name occupies, or `undefined` when the schema has no answer.
 *
 * Positional order is `SlimType.f`, which is the IDD order and includes the name at index 0 for a
 * named type. `Statement.fields` is indexed from the first field after the type name, so a fixed
 * field's index into it is simply its position in `f` for both named and anonymous types: on a
 * named type index 0 is the name, and on an anonymous one index 0 is the first real field, which is
 * what `f` holds in each case.
 *
 * An extensible field lives in the repeat group instead, which begins where the fixed fields end.
 * The arithmetic is the one place this can go wrong quietly: a finding about the ninth vertex of a
 * surface positioned at the first looks plausible in a screenshot and is useless in an editor. Worked
 * on `BuildingSurface:Detailed`, whose eleven fixed fields are followed by repeats three wide, the
 * x coordinate of the ninth vertex is `11 + 8 * 3 + 0`, which is field 35 of the statement.
 */
function fieldIndexOf(
  type: SlimType,
  field: string,
  repeat: number | undefined
): number | undefined {
  const fixed = type.f.indexOf(field);
  if (fixed !== -1) return fixed;

  const extensible = type.x;
  if (extensible === undefined) return undefined;
  const offsetWithinGroup = extensible.fields.indexOf(field);
  if (offsetWithinGroup === -1) return undefined;
  // Which repeat is not something a `ValidationError` can say, and a wrong repeat is worse than no
  // position at all, so without one this declines to answer and the caller falls back to the
  // statement.
  if (repeat === undefined) return undefined;

  const fixedCount = type.f.length;
  const groupWidth = extensible.fields.length;
  return fixedCount + repeat * groupWidth + offsetWithinGroup;
}

// ---------------------------------------------------------------------------
// Reading findings, which name a place and are used as they are
// ---------------------------------------------------------------------------

/**
 * Where a reading finding sits, from the line and column the scanner recorded.
 *
 * Correlation is not used and must not be: a duplicate-name finding names a type and a name that
 * belong to the statement ABOVE the one it is about, so correlating it would underline the wrong
 * object. The scanner saw the offending statement and said where it was, and that answer is better
 * than any reconstruction of it.
 *
 * A finding whose column resolves to the statement's own first character is about the statement, and
 * every finding `lex` and `parseIdf` produce about a statement carries one. A finding carrying only
 * a line is about a field on that line, which is what the `InvalidField` diagnostic is; it becomes
 * field-precise when exactly one field begins on that line, and stays statement-precise when several
 * do, because then which one is meant is not recoverable.
 */
function placeParse(finding: ParseDiagnostic, layer: SyntaxLayer): Placement | undefined {
  const span = lineSpan(layer, finding.line);
  const statement = statementNear(layer, span);
  if (statement === undefined) return undefined;

  if (finding.column !== undefined) {
    const at = offsetAt(layer, { line: finding.line, column: finding.column });
    if (at === statement.region.start) {
      return { region: statement.typeName, precision: 'statement' };
    }
  }

  const field = soleFieldOn(statement, span);
  return field === undefined
    ? { region: statement.region, precision: 'statement' }
    : { region: field, precision: 'field' };
}

/** The statement a line falls in, or the one beginning later on it when the line falls between two. */
function statementNear(layer: SyntaxLayer, span: Region): Statement | undefined {
  const statements = layer.statements;
  const at = lastStartingAtOrBefore(statements, span.start);
  const containing = at === -1 ? undefined : statements[at];
  if (containing !== undefined && span.start < containing.region.end) return containing;
  // Between two statements, which is where a finding on the blank line above a statement lands.
  const next = statements[at + 1];
  return next !== undefined && next.region.start <= span.end ? next : containing;
}

/** The one field beginning on this line, or `undefined` when none or several do. */
function soleFieldOn(statement: Statement, span: Region): Region | undefined {
  let found: Region | undefined;
  for (const field of statement.fields) {
    if (field.start < span.start || field.start > span.end) continue;
    if (found !== undefined) return undefined;
    found = field;
  }
  return found;
}

/** Index of the last statement beginning at or before `offset`, or -1 when none does. */
function lastStartingAtOrBefore(statements: readonly Statement[], offset: number): number {
  let low = 0;
  let high = statements.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (statements[middle]!.region.start <= offset) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
}

/**
 * The offsets a 1-based line begins and ends at, the ending one being the line break itself.
 *
 * `offsetAt` clamps a column past the end of its line to that break, so asking for an impossible
 * column is how the end is found without a second index of the text.
 */
function lineSpan(layer: SyntaxLayer, line: number): Region {
  return {
    start: offsetAt(layer, { line, column: 1 }),
    end: offsetAt(layer, { line, column: Number.MAX_SAFE_INTEGER }),
  };
}

// ---------------------------------------------------------------------------
// Telling the two shapes apart
// ---------------------------------------------------------------------------

/**
 * A `ValidationError` names an object type; nothing else this positions does.
 *
 * Structural rather than nominal because `position` is generic over the finding, which is what keeps
 * both types unmodified. The two shapes are disjoint on this property in both libraries.
 */
function isValidationShaped(finding: object): finding is ValidationError {
  return typeof (finding as { objType?: unknown }).objType === 'string';
}

/** A `ParseDiagnostic` names a line. Checked after the above, since a validation finding names none. */
function isParseShaped(finding: object): finding is ParseDiagnostic {
  return typeof (finding as { line?: unknown }).line === 'number';
}

/** Whatever a caller attached to say which occurrence a finding is about. See {@link Occurrence}. */
function occurrenceOf(finding: object): Occurrence {
  const carried = finding as Occurrence;
  return {
    ordinal: typeof carried.ordinal === 'number' ? carried.ordinal : undefined,
    index: typeof carried.index === 'number' ? carried.index : undefined,
  };
}

/** Case folding, as EnergyPlus resolves a type name and as `IdfCollection` keys a name. */
function fold(value: string): string {
  return value.toLowerCase();
}

/**
 * The two halves of the name key, joined by a character neither of them can contain.
 *
 * An object name routinely holds spaces, commas and punctuation, so the separator is the one
 * character IDF text cannot carry at all. Joining on anything a name may hold would let two
 * different pairs produce one key.
 */
function nameKey(type: string, name: string): string {
  return `${type}${SEPARATOR}${name}`;
}

/**
 * The NUL character itself, written as a constant rather than as an escape inside the template.
 *
 * `\u0000` inside a template literal needs one backslash, and a second one turns it into the
 * six printable characters `\u0000`, which a name may perfectly well contain: the join would then
 * be ambiguous in exactly the way the doc comment above says it is not.
 */
const SEPARATOR = '\u0000';
