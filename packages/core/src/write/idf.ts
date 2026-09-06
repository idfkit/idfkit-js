import type { FieldKind, SlimType } from '@idfkit/schemas';

import type { IdfDocument } from '../document.js';
import { writePreserved } from '../preserve/write.js';
import type { PreservedSource } from '../preserve/source.js';
import type { AnyTypeMap } from '../typemap.js';
import type { IdfObject, StoredValue } from '../object.js';

export interface WriteIdfOptions {
  /**
   * Emit `!- Field Name` comments after each field.
   * @defaultValue true
   */
  comments?: boolean;
  /**
   * Column the field-name comments are aligned to, counting from 1 as an editor does.
   *
   * The default puts `!-` where EnergyPlus itself puts it. Its own example files write the marker
   * at column 30 on 223 of the 231 commented lines of `1ZoneUncontrolled.idf`, and matching that
   * is what keeps a rewritten object flush with the untouched objects around it: on a preserving
   * write, a column of its own would leave a visible seam at every edit.
   *
   * @defaultValue 30
   */
  commentColumn?: number;
  /**
   * Indent for field lines.
   * @defaultValue '    '
   */
  indent?: string;
  /**
   * Write `Version` first regardless of insertion order. EnergyPlus does not
   * require it, but every tool in the ecosystem expects it and diffs are
   * cleaner when it is stable.
   * @defaultValue true
   */
  versionFirst?: boolean;
  /**
   * How object types are ordered.
   *
   * `'source'` keeps the order the types first appeared in the document, which is what this writer
   * has always done and remains the default: no default moves (FR-017). `'sorted'` orders them by
   * type name, which is the other language's default and what its `!-Option SortedOrder` header
   * declares.
   *
   * An enumeration rather than a boolean, because three behaviours exist across the two languages
   * and two formats and a flag cannot say which of the three is wanted.
   *
   * Orthogonal to `versionFirst`, which pins `Version` ahead of whichever order this selects.
   *
   * @defaultValue 'source'
   */
  ordering?: 'sorted' | 'source';
  /**
   * Put each object on a single line, with no comments and no blank separators.
   *
   * The counterpart of the other language's `output_type="compressed"`, and it means the same
   * thing: type name and values joined by commas, one object per line, no generator header, no
   * blank line between objects. The corpus checks that the two agree structurally rather than
   * textually, because the two writers differ on defaults that compressed output does not remove.
   *
   * `comments: false` is not this. That skips the padding and the comment and still puts every
   * field on its own line, which is a different, coarser output that both languages already had.
   *
   * @defaultValue false
   */
  compressed?: boolean;
  /**
   * Reproduce the text the document was read from, per object.
   *
   * Tri-state: absent decides from the document and the other options, `true` preserves and
   * refuses a contradictory request, `false` formats. Asking for it on a document read without it
   * is not an error, because nothing was promised.
   *
   * Refused together with `indent`, `commentColumn`, `ordering` or `versionFirst`: reproducing the
   * original text and laying it out differently are contradictory. Not refused with `compressed`
   * or `comments: false`, which ask for a different output FORM the source was never going to
   * express, so producing it is honest.
   *
   * @defaultValue undefined, meaning decide
   */
  preserveFormatting?: boolean;
  /**
   * What to do about a field the author deliberately left without a comment.
   *
   * Only meaningful on the preserving path, which is the only path that knows what the author
   * wrote. `'preserve'` leaves a bare field bare, because absence is as much a thing the author
   * wrote as the words are. `'generate'` labels it, for a caller who wants the file annotated.
   *
   * Neither setting touches the author's own comment lines. A comment between two objects is
   * carried by the text between them, and a comment on its own line inside an object is emitted
   * with the field below it, so asking for labels adds them and never costs a line.
   *
   * @defaultValue 'preserve'
   */
  fieldComments?: 'preserve' | 'generate';
}

/**
 * Serialize a document to IDF text.
 *
 * Two behaviours, chosen by how the document was read. A document read with `preserveFormatting`
 * is written back per object: anything unchanged is reproduced from the characters it was read
 * from, and everything between the objects is copied. A document read without it is formatted,
 * which is what this writer has always done and still does by default.
 *
 * The caveat that used to be stated here applies to the formatting path alone: `3.0` comes back as
 * `3` for a field the schema does not declare numeric. On the preserving path nothing is
 * re-rendered, so nothing is lost.
 */
export function writeIdf<M extends AnyTypeMap>(
  document: IdfDocument<M>,
  options: WriteIdfOptions = {}
): string {
  const preserved = decidePreservation(document, options);
  if (preserved !== undefined) {
    return writePreserved(document, preserved, {
      comments: options.comments ?? true,
      commentColumn: options.commentColumn ?? 30,
      indent: options.indent ?? '    ',
      labelBareFields: options.fieldComments === 'generate',
    });
  }

  const compressed = options.compressed ?? false;
  // Compressed output has no comments by definition. Asking for both is not an error, because the
  // narrower request is unambiguous: comments cannot survive a single-line object.
  const comments = compressed ? false : (options.comments ?? true);
  const commentColumn = options.commentColumn ?? 30;
  const indent = options.indent ?? '    ';
  const versionFirst = options.versionFirst ?? true;
  const ordering = options.ordering ?? 'source';

  const parts: string[] = [];
  const types = document.types();

  // Sorted first, then Version pinned, so the two controls compose the way the other language's
  // output does: its `SortedOrder` header describes the type ordering and Version sits above it.
  if (ordering === 'sorted') types.sort();

  if (versionFirst && types.includes('Version')) {
    types.splice(types.indexOf('Version'), 1);
    types.unshift('Version');
  }

  for (const typeName of types) {
    const collection = document.all(typeName);
    if (collection.size === 0) continue;
    for (const obj of collection) {
      parts.push(writeObject(obj, { comments, commentColumn, indent, compressed }));
    }
    // The blank separator after each type is one of the two things compressed removes. The other
    // is the per-field line break, in `writeObject`.
    if (!compressed) parts.push('');
  }

  return parts.join('\n');
}

/**
 * The retained source to preserve from, or `undefined` to format.
 *
 * The branches below are the decision table, in order. Two are worth naming: preservation asked
 * for on a document that has none is a quiet fallback rather than an error, and a reformatting
 * control set WITHOUT asking for preservation is a request to format, so a control is never
 * silently dropped in favour of the source.
 */
function decidePreservation<M extends AnyTypeMap>(
  document: IdfDocument<M>,
  options: WriteIdfOptions
): PreservedSource | undefined {
  if (options.preserveFormatting === false) return undefined;
  // A different output FORM is a different artifact, so granting it is honest.
  if (options.compressed === true || options.comments === false) return undefined;

  const source = document.preservedSource;
  const reformatting =
    options.indent !== undefined ||
    options.commentColumn !== undefined ||
    options.ordering !== undefined ||
    options.versionFirst !== undefined;

  // A document read from the object notation carries JSON text and preserves on that format's
  // all-or-nothing terms. Handing it to this walk would emit JSON under an IDF writer's name.
  if (source === undefined || source.format !== 'idf') return undefined;
  if (reformatting) {
    if (options.preserveFormatting === true) {
      // Names the CLASS of controls, not the one the caller happened to set: a caller who set two
      // learns about both.
      throw new TypeError(
        'preserveFormatting reproduces the original text, so it cannot also apply indent, ' +
          'commentColumn, ordering or versionFirst. Pass one or the other.'
      );
    }
    return undefined;
  }
  return source;
}

export interface ObjectWriteOptions {
  comments: boolean;
  /** Where `!-` goes, counted from 1. See {@link WriteIdfOptions.commentColumn}. */
  commentColumn: number;
  indent: string;
  /** Put the whole object on one line. See `WriteIdfOptions.compressed`. */
  compressed?: boolean;
  /**
   * What the author wrote around each field, positionally.
   *
   * Supplied by the preserving writer and by nothing else. Re-rendering an object's VALUES is what
   * an edit asks for; rebuilding what surrounds them is not, and doing it anyway destroys anything
   * the schema cannot regenerate.
   *
   * Positional, and shorter than the cells whenever the object gained fields. A field past the end
   * has no author to be faithful to, so it is labelled as it always was.
   *
   * @internal
   */
  annotations?: readonly FieldAnnotation[];
  /**
   * Label a field the author deliberately left bare.
   *
   * `false` is faithful and is what the preserving path asks for: a field written without a comment
   * was written that way on purpose, and absence is as much a thing the author wrote as the words
   * are. `true` restores the ordinary writer's behaviour of labelling every field, for a caller who
   * wants the file annotated.
   *
   * Either way the author's own standalone comment lines are emitted, so turning this on adds
   * labels and never costs a line.
   *
   * @internal
   */
  labelBareFields?: boolean;
}

/**
 * What the author wrote around one field.
 *
 * @internal
 */
export interface FieldAnnotation {
  /**
   * Comment lines standing on their own above this field, in order, exactly as written.
   *
   * These live INSIDE the statement, so unlike a comment between two statements they are not
   * carried by the gap and are lost the moment the object is reformatted unless they are emitted
   * here. `! this value came from the 2019 survey` is the shape, and it is the author's note about
   * the field below it.
   */
  readonly before: readonly string[];
  /** The comment after this field's delimiter on the same line, if the author wrote one. */
  readonly trailing: string | undefined;
  /**
   * Whether the author began a new line with this field.
   *
   * False for the second and third coordinate of a vertex written `0,0,4.572,` on one line. Writing
   * one value per line regardless turns a four-line surface into twelve, which is the most visible
   * thing a reformat does to a geometry file: 21.5 percent of the statements in the 693 EnergyPlus
   * example files group values this way, and 690 of those files contain at least one.
   */
  readonly startsLine: boolean;
}

/** Serialize one object. */
export function writeObject(obj: IdfObject, options: ObjectWriteOptions): string {
  const definition = obj.schema;
  const cells: Array<{ value: string; label: string }> = [];

  if (obj.isNamed) {
    cells.push({ value: obj.name, label: 'Name' });
  }

  const extensible = definition.x;
  const groups = extensible === undefined ? [] : obj.extensible;

  const fixed = definition.f.filter((f) => f !== 'name');
  // Trailing empty fields are normally dropped, since EnergyPlus defaults them
  // and a run of bare commas is noise. But IDF is positional: if extensible
  // groups follow, every fixed slot must be emitted or the groups land one
  // field early and each value is read into the wrong slot on the way back in.
  //
  // The annotations are the third case, and the reason is the one that governs this whole path: a
  // field the author WROTE OUT as a blank is as much a thing the author wrote as a field left
  // bare of its comment. Dropping it takes the author's `!- Cooling Design Capacity Method` with
  // it, so a single-field edit shortens one Sizing:System from 38 lines to 22. Across the 693
  // example files that is 20,571 lines, more than any other difference a rewrite makes.
  //
  // Only on this path. A write with no author behind it keeps trimming, as it always has.
  const authored = options.annotations?.length ?? 0;
  const lastAuthored = authored - (obj.isNamed ? 1 : 0) - 1;
  const lastFixed =
    groups.length > 0
      ? fixed.length - 1
      : Math.min(fixed.length - 1, Math.max(lastSetIndex(obj, fixed), lastAuthored));
  for (let i = 0; i <= lastFixed; i += 1) {
    const field = fixed[i]!;
    cells.push({ value: formatValue(definition, field, obj.get(field)), label: humanize(field) });
  }

  if (extensible !== undefined) {
    for (const group of groups) {
      for (const field of extensible.fields) {
        cells.push({
          value: formatScalar(extensible.p[field]?.t, group[field]),
          label: humanize(field),
        });
      }
    }
  }

  // Compressed output carries no trailing newline of its own: `writeIdf` joins the parts with one,
  // and adding a second here is what puts a blank line between objects. Removing that blank line
  // is half of what compressed means.
  if (cells.length === 0) {
    return options.compressed ? `${obj.typeName};` : `${obj.typeName};\n`;
  }

  if (options.compressed) {
    // Type name and every value on one line, comma-separated, terminated once. The same shape the
    // other language produces, whose writer joins the values and skips the header and separators.
    return `${obj.typeName},${cells.map((cell) => cell.value).join(',')};`;
  }

  const lines: string[] = [];

  // A line under construction, so fields the author wrote together stay together. Flushed when the
  // next field opens a line of its own, and once at the end.
  //
  // It starts as the TYPE NAME rather than the type name being pushed straight out, so that an
  // object the author wrote entirely on one line, `Timestep,4;`, can come back on one line. That is
  // 11.3 percent of the statements in the example files, and it is the case that surprises on a
  // file with no geometry in it: nobody thinks of `Timestep,4;` as formatting they chose.
  let open = `${obj.typeName},`;
  let openComment: string | undefined;
  const flush = (): void => {
    if (open === '') return;
    if (openComment === undefined) {
      lines.push(open);
    } else {
      // Minus one because the option is a COLUMN, counted from 1, and this is an offset into a
      // string, counted from 0. Applying it as an offset put every comment one column right of
      // where the files being imitated put it.
      const padding = ' '.repeat(Math.max(1, options.commentColumn - 1 - open.length));
      lines.push(`${open}${padding}${openComment}`);
    }
    open = '';
    openComment = undefined;
  };

  cells.forEach((cell, index) => {
    const terminator = index === cells.length - 1 ? ';' : ',';
    const annotation = options.annotations?.[index];
    // No annotation means no author to be faithful to, so one value per line as this writer always
    // did. Field 0 is the one that decides whether the object opens on the type name's own line.
    const opensLine = annotation === undefined || annotation.startsLine;

    if (opensLine) {
      flush();
      for (const line of annotation?.before ?? []) lines.push(`${options.indent}${line}`);
      open = `${options.indent}${cell.value}${terminator}`;
    } else {
      open = `${open} ${cell.value}${terminator}`;
    }

    if (!options.comments) return;
    // The author's comment where there is one. Where the author left the field bare, nothing,
    // unless the caller asked for a label. Where there is no author at all, the label as always.
    // On a line carrying several values only the last has a comment, which is what the author
    // wrote and what the delimiter rule recovers.
    const comment =
      annotation === undefined
        ? `!- ${cell.label}`
        : (annotation.trailing ??
          (options.labelBareFields === true ? `!- ${cell.label}` : undefined));
    if (comment !== undefined) openComment = comment;
  });
  flush();

  return `${lines.join('\n')}\n`;
}

function lastSetIndex(obj: IdfObject, fields: readonly string[]): number {
  for (let i = fields.length - 1; i >= 0; i -= 1) {
    if (obj.get(fields[i]!) !== undefined) return i;
  }
  return -1;
}

function formatValue(definition: SlimType, field: string, value: StoredValue | undefined): string {
  return formatScalar(definition.p[field]?.t, value);
}

/**
 * Render one value as IDF text.
 *
 * The `kind === 'n'` branch is the fix for JavaScript having a single number
 * type: `3` and `3.0` are the same value at runtime, so without consulting the
 * schema every real-valued field would be written as a bare integer.
 */
function formatScalar(kind: FieldKind | undefined, value: StoredValue | undefined): string {
  if (value === undefined || Array.isArray(value)) return '';
  if (typeof value === 'string') return value;

  if (kind === 'i') return String(Math.trunc(value));
  if (Number.isInteger(value)) {
    return kind === 'n' ? `${value}.0` : String(value);
  }
  return String(value);
}

/**
 * Minor words EnergyPlus leaves lowercase in its own field comments, as in
 * `Direction of Relative North` and `Number of Timesteps per Hour`.
 */
const MINOR_WORDS = new Set([
  'a',
  'an',
  'and',
  'at',
  'by',
  'for',
  'from',
  'in',
  'of',
  'on',
  'or',
  'per',
  'the',
  'to',
  'with',
]);

/**
 * `outside_boundary_condition` -> `Outside Boundary Condition`.
 *
 * The exact IDD field labels live in the schema's `field_info`, which the slim
 * bundle drops because it is documentation weight on the parse path. Deriving
 * the label from the epJSON key recovers it almost exactly; the comments are
 * cosmetic and EnergyPlus ignores them entirely.
 */
function humanize(field: string): string {
  return field
    .split('_')
    .map((word, index) => {
      if (word.length === 0) return word;
      if (index > 0 && MINOR_WORDS.has(word)) return word;
      return word[0]!.toUpperCase() + word.slice(1);
    })
    .join(' ');
}
