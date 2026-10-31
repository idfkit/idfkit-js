import type { SlimType } from '@idfkit/schemas';

import type { IdfDocument } from './document.js';
import type { ExtensibleGroup, FieldValue, IdfObject } from './object.js';
import type { AnyTypeMap } from './typemap.js';

/**
 * What differs between two documents of one EnergyPlus version, object by object.
 *
 * Returned by {@link diffDocuments}. Empty `objects` means the two documents hold the same
 * objects with the same values, whatever order they hold them in.
 */
export interface DocumentDelta {
  /** The EnergyPlus version both documents target, e.g. `"26.1.0"`. */
  readonly version: string;
  /**
   * One entry per object that differs.
   *
   * In the second document's order: type by type as `after.types()` lists them, and within a type
   * the objects of `after` in collection order, each type's removed objects following its others in
   * the first document's order. Types present only in the first document come last.
   */
  readonly objects: readonly ObjectDelta[];
}

/** One object that differs between two documents, discriminated by `kind`. */
export type ObjectDelta = ObjectAdded | ObjectRemoved | ObjectChanged | ObjectRenamed;

/** An object present in the second document and matched to nothing in the first. */
export interface ObjectAdded {
  readonly kind: 'added';
  /** Canonical object type name, e.g. `Zone`. */
  readonly type: string;
  /** Its name, or `''` for an object without one. */
  readonly name: string;
  /** The object, in the second document. */
  readonly object: IdfObject;
}

/** An object present in the first document and matched to nothing in the second. */
export interface ObjectRemoved {
  readonly kind: 'removed';
  /** Canonical object type name, e.g. `Zone`. */
  readonly type: string;
  /** Its name, or `''` for an object without one. */
  readonly name: string;
  /** The object, in the first document. */
  readonly object: IdfObject;
}

/** An object present in both documents under one name, with at least one field that differs. */
export interface ObjectChanged {
  readonly kind: 'changed';
  /** Canonical object type name, e.g. `Zone`. */
  readonly type: string;
  /** Its name, or `''` for a singleton without one, such as `Timestep`. */
  readonly name: string;
  /** The object, in the first document. */
  readonly before: IdfObject;
  /** The object, in the second document. */
  readonly after: IdfObject;
  /** The fields that differ, in positional order and then repeat by repeat. Never empty. */
  readonly fields: readonly FieldChange[];
}

/**
 * An object present in both documents under two names.
 *
 * Reported whether or not anything else about it changed, so `fields` may be empty.
 */
export interface ObjectRenamed {
  readonly kind: 'renamed';
  /** Canonical object type name, e.g. `Zone`. */
  readonly type: string;
  /** Its name in the first document. */
  readonly from: string;
  /** Its name in the second document. */
  readonly to: string;
  /** The object, in the first document. */
  readonly before: IdfObject;
  /** The object, in the second document. */
  readonly after: IdfObject;
  /** The fields that differ apart from the name, in positional order and then repeat by repeat. */
  readonly fields: readonly FieldChange[];
  /**
   * Every field elsewhere that changed from the old name to the new one, and is therefore part of
   * this rename rather than an edit of the object holding it. In the order of {@link
   * DocumentDelta.objects}.
   */
  readonly references: readonly ReferenceRewrite[];
}

/** One field that differs within an object present in both documents, discriminated by `kind`. */
export type FieldChange = FieldValueChange | GroupFieldChange | GroupAdded | GroupRemoved;

/** A positional field whose value differs. */
export interface FieldValueChange {
  readonly kind: 'field';
  /** The epJSON field name, as `obj.get(field)` takes it, e.g. `ceiling_height`. */
  readonly field: string;
  /** The value in the first document, `undefined` where the field is not set. */
  readonly before: FieldValue;
  /** The value in the second document, `undefined` where the field is not set. */
  readonly after: FieldValue;
}

/** A field inside one extensible repeat, at a position both documents hold, whose value differs. */
export interface GroupFieldChange {
  readonly kind: 'group-field';
  /** The extensible key, e.g. `vertices`. */
  readonly key: string;
  /** The repeat's position, as `obj.extensible[index]` takes it. */
  readonly index: number;
  /** The field within the repeat, e.g. `vertex_x_coordinate`. */
  readonly field: string;
  /** The value in the first document, `undefined` where the field is not set. */
  readonly before: FieldValue;
  /** The value in the second document, `undefined` where the field is not set. */
  readonly after: FieldValue;
}

/** An extensible repeat at a position only the second document holds. */
export interface GroupAdded {
  readonly kind: 'group-added';
  /** The extensible key, e.g. `vertices`. */
  readonly key: string;
  /** The repeat's position in the second document. */
  readonly index: number;
  /** A copy of the repeat. */
  readonly group: ExtensibleGroup;
}

/** An extensible repeat at a position only the first document holds. */
export interface GroupRemoved {
  readonly kind: 'group-removed';
  /** The extensible key, e.g. `vertices`. */
  readonly key: string;
  /** The repeat's position in the first document. */
  readonly index: number;
  /** A copy of the repeat. */
  readonly group: ExtensibleGroup;
}

/** A reference that a rename rewrote, in the object holding it. */
export interface ReferenceRewrite {
  /** Canonical type name of the object holding the reference. */
  readonly type: string;
  /** Its name, or `''` for an object without one, such as `ZoneHVAC:EquipmentConnections`. */
  readonly name: string;
  /** The object holding the reference, in the second document. */
  readonly object: IdfObject;
  /** Where the reference sits, and its value in each document. */
  readonly change: FieldValueChange | GroupFieldChange;
}

/**
 * Thrown by {@link diffDocuments} when the two documents target different EnergyPlus versions.
 *
 * Field order and reference lists differ between releases, so a field-by-field comparison of two
 * versions would report the schema's changes as the model's. Migrating one document to the other's
 * version is outside this library.
 */
export class IncomparableVersionsError extends Error {
  /** The first document's version. */
  readonly before: string;
  /** The second document's version. */
  readonly after: string;

  constructor(before: string, after: string) {
    super(
      `Cannot compare documents of different EnergyPlus versions: ${before} and ${after}. ` +
        'Both documents must target one version.'
    );
    this.name = 'IncomparableVersionsError';
    this.before = before;
    this.after = after;
  }
}

/**
 * Describe what differs between two documents of one EnergyPlus version, by object and by field.
 *
 * Synchronous and read-only: neither document is changed, and a document read with
 * `preserveFormatting` reports no {@link IdfDocument.changedObjects} afterwards that it did not
 * report before. This answers a different question from `changedObjects`, which compares a
 * document with its OWN source text; this compares two documents with each other, however each
 * was made.
 *
 * ```ts
 * const before = parseIdf(oldText, schema).document;
 * const after = parseIdf(newText, schema).document;
 * for (const entry of diffDocuments(before, after).objects) {
 *   if (entry.kind === 'renamed') console.log(`${entry.type} ${entry.from} is now ${entry.to}`);
 * }
 * ```
 *
 * ## Matching objects
 *
 * Objects are matched within their type, in this order:
 *
 * 1. A singleton type, such as `Building` or `Timestep`, is matched by type alone. Its name, if it
 *    has one, may differ, and is then reported as a rename.
 * 2. An object with a name is matched to the object of its type with the same name, compared
 *    case-insensitively as EnergyPlus compares names. A name that differs only in letter case is
 *    reported as a rename.
 * 3. Objects with a name left unmatched are paired as renames by the rule below.
 * 4. An object without a name, either because its type has no name field (`Output:Variable`) or
 *    because it was left blank, has no identity beyond its content. It is matched to an object of
 *    its type with equal content, or equal content once the references explained by the renames
 *    of step 3 are set aside, taking the first such object in document order. An object without a
 *    name that was edited is therefore reported as one removal and one addition.
 *
 * Anything left unmatched is reported as added or removed. Position is not compared: an object
 * moved within its type, or a type moved within the document, is not reported. The delta describes
 * what the documents hold, and EnergyPlus finds an object by its type and name, not its position.
 *
 * ## The rename rule
 *
 * A removed object and an added object of the same type, both with a name, are paired as a rename
 * when each is the other's only candidate. Candidates are found in two passes, and the second pass
 * considers only the objects the first left unpaired:
 *
 * 1. **By reference.** A field of an object matched by step 1 or 2 above held the removed object's
 *    name in the first document and the added object's name in the second, and the field reads
 *    from a reference list that the type's name enters (the field's `ol` meets the type's `nref`).
 * 2. **By content.** Every field and every extensible repeat of the two objects is equal.
 *
 * When an object has more than one candidate in a pass, or its candidate has more than one, no
 * rename is reported for it in that pass. Two identical objects renamed together, or two objects
 * merged into one, are reported as removals and additions. The rule never chooses between
 * candidates, so the result does not depend on anything but the two documents.
 *
 * An object renamed and edited is recognised only by reference: nothing else distinguishes it
 * from one object deleted and another created.
 *
 * ## References rewritten by a rename
 *
 * Reported under the rename, in {@link ObjectRenamed.references}, and NOT as field changes of the
 * objects holding them. `rename` is one operation in this library, the one `IdfDocument.rename`
 * performs: change a name and repoint every reference to it. Reporting its rewrites as edits would
 * describe one operation as many, and leave a consumer unable to tell a reference the user
 * repointed from one the rename repointed without repeating the reference-list analysis done
 * here. An object whose only differences are rewritten references therefore has no entry of its
 * own; one with other edits has an `ObjectChanged` entry listing only those.
 *
 * A field change is attributed to a rename when its old value equals the old name and its new value
 * the new name, both case-insensitively, the field reads from a reference list the renamed type's
 * name enters, and exactly one rename fits. Any other change of a reference field is an ordinary
 * field change.
 *
 * ## Comparing values
 *
 * Values are compared exactly as the object model stores them. A change of letter case is a change.
 * A field that is not set reads `undefined`, so a field cleared is a change to `undefined`, and a
 * field written at its schema default is a change from the field left blank: the two run alike in
 * EnergyPlus, but they are different documents and the writers emit different text. Defaults are
 * not applied.
 *
 * Extensible repeats are compared by position, as `obj.extensible[index]` addresses them. Order is
 * content here: reversing a surface's vertices turns it to face the other way. A repeat appended is
 * a `group-added` at its index and the last one removed a `group-removed`; a repeat inserted or
 * removed elsewhere, or repeats reordered, appear as `group-field` changes at every position whose
 * values differ.
 *
 * @throws {@link IncomparableVersionsError} when the documents target different EnergyPlus
 *   versions. Identical documents are not an error and return an empty delta.
 */
export function diffDocuments<A extends AnyTypeMap, B extends AnyTypeMap>(
  before: IdfDocument<A>,
  after: IdfDocument<B>
): DocumentDelta {
  if (before.version !== after.version) {
    throw new IncomparableVersionsError(before.version, after.version);
  }

  const beforeByType = byType(before.objects());
  const afterByType = byType(after.objects());
  const pairs = new Pairing();

  // Steps 1 and 2: identity by type for a singleton, by name for everything else that has one.
  for (const [type, olds] of beforeByType) {
    const news = afterByType.get(type);
    if (news === undefined) continue;
    const definition = olds[0]!.schema;
    if (definition.s === 1) {
      pairs.add(olds[0]!, news[0]!);
      continue;
    }
    const byName = new Map<string, IdfObject>();
    for (const obj of news) if (obj.name !== '') byName.set(obj.name.toLowerCase(), obj);
    for (const obj of olds) {
      const match = obj.name === '' ? undefined : byName.get(obj.name.toLowerCase());
      if (match !== undefined) pairs.add(obj, match);
    }
  }

  // The identity pairs' changes, computed once: they are the evidence for the first rename pass and
  // they are what gets reported.
  const identityChanges = new Map<IdfObject, FieldChange[]>();
  for (const [old, current] of pairs.forward) {
    identityChanges.set(old, compareObjects(old, current));
  }

  // Step 3: renames.
  const renames: Rename[] = [];
  for (const [old, current] of pairs.forward) {
    if (old.name !== current.name) renames.push(newRename(old, current));
  }
  const removedNamed = unpaired(beforeByType, pairs.forward, true);
  const addedNamed = unpaired(afterByType, pairs.backward, true);
  for (const [old, current] of acceptUnique(
    referenceCandidates(pairs.forward, identityChanges, removedNamed, addedNamed)
  )) {
    pairs.add(old, current);
    renames.push(newRename(old, current));
  }
  for (const [old, current] of acceptUnique(
    contentCandidates(
      unpaired(beforeByType, pairs.forward, true),
      unpaired(afterByType, pairs.backward, true)
    )
  )) {
    pairs.add(old, current);
    renames.push(newRename(old, current));
  }
  const renameOf = new Map<IdfObject, Rename>(renames.map((rename) => [rename.after, rename]));

  // Step 4: objects without a name, by content and then by content modulo the renames.
  matchUnnamed(beforeByType, afterByType, pairs, renames);

  // Report, in the second document's order.
  const objects: ObjectDelta[] = [];
  const types = [...afterByType.keys()];
  for (const type of beforeByType.keys()) if (!afterByType.has(type)) types.push(type);
  for (const type of types) {
    for (const current of afterByType.get(type) ?? []) {
      const old = pairs.backward.get(current);
      if (old === undefined) {
        objects.push({ kind: 'added', type, name: current.name, object: current });
        continue;
      }
      const fields: FieldChange[] = [];
      for (const change of identityChanges.get(old) ?? compareObjects(old, current)) {
        if (change.kind === 'field' || change.kind === 'group-field') {
          const rename = attribute(current.schema, change, renames);
          if (rename !== undefined) {
            rename.references.push({ type, name: current.name, object: current, change });
            continue;
          }
        }
        fields.push(change);
      }
      const rename = renameOf.get(current);
      if (rename !== undefined) {
        objects.push({
          kind: 'renamed',
          type,
          from: old.name,
          to: current.name,
          before: old,
          after: current,
          fields,
          references: rename.references,
        });
      } else if (fields.length > 0) {
        objects.push({
          kind: 'changed',
          type,
          name: current.name,
          before: old,
          after: current,
          fields,
        });
      }
    }
    for (const old of beforeByType.get(type) ?? []) {
      if (!pairs.forward.has(old)) {
        objects.push({ kind: 'removed', type, name: old.name, object: old });
      }
    }
  }

  return { version: after.version, objects };
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/** Objects matched across the two documents, looked up from either side. */
class Pairing {
  readonly forward = new Map<IdfObject, IdfObject>();
  readonly backward = new Map<IdfObject, IdfObject>();

  add(old: IdfObject, current: IdfObject): void {
    this.forward.set(old, current);
    this.backward.set(current, old);
  }
}

/** A rename found by the matching, and the references reported under it as they are found. */
interface Rename {
  readonly after: IdfObject;
  readonly from: string;
  readonly to: string;
  /** The reference lists the type's name enters. */
  readonly lists: ReadonlySet<string>;
  readonly references: ReferenceRewrite[];
}

function newRename(old: IdfObject, current: IdfObject): Rename {
  return {
    after: current,
    from: old.name.toLowerCase(),
    to: current.name.toLowerCase(),
    lists: new Set(current.schema.nref ?? []),
    references: [],
  };
}

/** A document's objects grouped by canonical type, both in document order. */
function byType(objects: Iterable<IdfObject>): Map<string, IdfObject[]> {
  const out = new Map<string, IdfObject[]>();
  for (const obj of objects) {
    let list = out.get(obj.typeName);
    if (list === undefined) {
      list = [];
      out.set(obj.typeName, list);
    }
    list.push(obj);
  }
  return out;
}

/** The objects not yet paired, by type, keeping only those with a name or only those without. */
function unpaired(
  grouped: ReadonlyMap<string, readonly IdfObject[]>,
  paired: ReadonlyMap<IdfObject, IdfObject>,
  named: boolean
): Map<string, IdfObject[]> {
  const out = new Map<string, IdfObject[]>();
  for (const [type, objects] of grouped) {
    const left = objects.filter((obj) => !paired.has(obj) && (obj.name !== '') === named);
    if (left.length > 0) out.set(type, left);
  }
  return out;
}

/** Candidate renames, from the removed object to every added object it could have become. */
type Candidates = Map<IdfObject, Set<IdfObject>>;

function addCandidate(candidates: Candidates, old: IdfObject, current: IdfObject): void {
  let set = candidates.get(old);
  if (set === undefined) {
    set = new Set();
    candidates.set(old, set);
  }
  set.add(current);
}

/**
 * The first pass: a reference field of an identity pair that moved from one unpaired name to
 * another, in a field that reads the type's reference lists.
 */
function referenceCandidates(
  identity: ReadonlyMap<IdfObject, IdfObject>,
  changes: ReadonlyMap<IdfObject, readonly FieldChange[]>,
  removed: ReadonlyMap<string, readonly IdfObject[]>,
  added: ReadonlyMap<string, readonly IdfObject[]>
): Candidates {
  const candidates: Candidates = new Map();
  if (removed.size === 0 || added.size === 0) return candidates;
  const removedByName = byLowerName(removed);
  const addedByName = byLowerName(added);

  for (const [old, current] of identity) {
    for (const change of changes.get(old) ?? []) {
      if (change.kind !== 'field' && change.kind !== 'group-field') continue;
      const { before, after } = change;
      if (typeof before !== 'string' || typeof after !== 'string') continue;
      if (before === '' || after === '' || before.toLowerCase() === after.toLowerCase()) continue;
      const lists = readsFrom(current.schema, change);
      if (lists.length === 0) continue;
      for (const source of removedByName.get(before.toLowerCase()) ?? []) {
        if (!entersAny(source.schema, lists)) continue;
        for (const target of addedByName.get(after.toLowerCase()) ?? []) {
          if (target.typeName === source.typeName) addCandidate(candidates, source, target);
        }
      }
    }
  }
  return candidates;
}

/** The second pass: the same type, and every field and repeat equal. */
function contentCandidates(
  removed: ReadonlyMap<string, readonly IdfObject[]>,
  added: ReadonlyMap<string, readonly IdfObject[]>
): Candidates {
  const candidates: Candidates = new Map();
  for (const [type, olds] of removed) {
    const news = added.get(type);
    if (news === undefined) continue;
    const byContent = new Map<string, IdfObject[]>();
    for (const obj of news) {
      const key = contentKey(obj);
      const list = byContent.get(key);
      if (list === undefined) byContent.set(key, [obj]);
      else list.push(obj);
    }
    for (const old of olds) {
      for (const current of byContent.get(contentKey(old)) ?? []) {
        addCandidate(candidates, old, current);
      }
    }
  }
  return candidates;
}

/**
 * The pairs in which each side is the other's only candidate, in the first document's order.
 *
 * The whole of the ambiguity rule: anything with two candidates, or whose candidate has two, is left
 * unpaired rather than resolved by order or by a score.
 */
function acceptUnique(candidates: Candidates): Array<[IdfObject, IdfObject]> {
  const claims = new Map<IdfObject, number>();
  for (const set of candidates.values()) {
    for (const current of set) claims.set(current, (claims.get(current) ?? 0) + 1);
  }
  const out: Array<[IdfObject, IdfObject]> = [];
  for (const [old, set] of candidates) {
    if (set.size !== 1) continue;
    const current = set.values().next().value as IdfObject;
    if (claims.get(current) === 1) out.push([old, current]);
  }
  return out;
}

/**
 * Pair the objects without a name, type by type, each with the first unpaired object of equal
 * content in document order; then the rest, each with the first whose only differences are
 * references explained by a rename.
 */
function matchUnnamed(
  beforeByType: ReadonlyMap<string, readonly IdfObject[]>,
  afterByType: ReadonlyMap<string, readonly IdfObject[]>,
  pairs: Pairing,
  renames: readonly Rename[]
): void {
  const removed = unpaired(beforeByType, pairs.forward, false);
  const added = unpaired(afterByType, pairs.backward, false);
  for (const [type, olds] of removed) {
    const news = added.get(type);
    if (news === undefined) continue;

    const byContent = new Map<string, IdfObject[]>();
    for (const obj of news) {
      const key = contentKey(obj);
      const list = byContent.get(key);
      if (list === undefined) byContent.set(key, [obj]);
      else list.push(obj);
    }
    const left: IdfObject[] = [];
    for (const old of olds) {
      const match = byContent.get(contentKey(old))?.shift();
      if (match === undefined) left.push(old);
      else pairs.add(old, match);
    }

    if (renames.length === 0) continue;
    for (const old of left) {
      const match = news.find(
        (current) =>
          !pairs.backward.has(current) &&
          compareObjects(old, current).every(
            (change) =>
              (change.kind === 'field' || change.kind === 'group-field') &&
              attribute(current.schema, change, renames) !== undefined
          )
      );
      if (match !== undefined) pairs.add(old, match);
    }
  }
}

function byLowerName(grouped: ReadonlyMap<string, readonly IdfObject[]>): Map<string, IdfObject[]> {
  const out = new Map<string, IdfObject[]>();
  for (const objects of grouped.values()) {
    for (const obj of objects) {
      const key = obj.name.toLowerCase();
      const list = out.get(key);
      if (list === undefined) out.set(key, [obj]);
      else list.push(obj);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

/** Every field of two objects of one type that differs, in positional order, then by repeat. */
function compareObjects(old: IdfObject, current: IdfObject): FieldChange[] {
  const out: FieldChange[] = [];
  const definition = current.schema;
  const key = definition.x?.key;
  for (const field of current.fieldNames) {
    if (field === key) continue;
    const before = old.get(field) as FieldValue;
    const after = current.get(field) as FieldValue;
    if (before !== after) out.push({ kind: 'field', field, before, after });
  }
  if (key === undefined) return out;

  const olds = groupsOf(old, key);
  const news = groupsOf(current, key);
  const common = Math.min(olds.length, news.length);
  for (let index = 0; index < common; index += 1) {
    const before = olds[index]!;
    const after = news[index]!;
    for (const field of groupFields(definition, before, after)) {
      if (before[field] !== after[field]) {
        out.push({
          kind: 'group-field',
          key,
          index,
          field,
          before: before[field],
          after: after[field],
        });
      }
    }
  }
  for (let index = common; index < olds.length; index += 1) {
    out.push({ kind: 'group-removed', key, index, group: { ...olds[index]! } });
  }
  for (let index = common; index < news.length; index += 1) {
    out.push({ kind: 'group-added', key, index, group: { ...news[index]! } });
  }
  return out;
}

/**
 * An object's repeats, read from the stored value.
 *
 * Not through `obj.extensible`, which stores an empty array on an object that had none and, on a
 * document read with preservation, wraps the stored array. A comparison must leave both documents
 * exactly as it found them.
 */
function groupsOf(obj: IdfObject, key: string): readonly ExtensibleGroup[] {
  const held = obj.get(key);
  return Array.isArray(held) ? held : [];
}

/** The fields either repeat holds, in the schema's order and then any the schema does not name. */
function groupFields(definition: SlimType, a: ExtensibleGroup, b: ExtensibleGroup): string[] {
  const declared = definition.x?.fields ?? [];
  const out = declared.filter((field) => field in a || field in b);
  for (const field of Object.keys(a)) if (!declared.includes(field)) out.push(field);
  for (const field of Object.keys(b)) {
    if (!declared.includes(field) && !(field in a)) out.push(field);
  }
  return out;
}

/**
 * A string equal for two objects of one type exactly when `compareObjects` finds no difference.
 *
 * A repeat keys only the fields it holds a value for: one wrapped by `obj.extensible` carries unset
 * fields as `undefined`.
 */
function contentKey(obj: IdfObject): string {
  const definition = obj.schema;
  const key = definition.x?.key;
  const values: unknown[] = [];
  for (const field of obj.fieldNames) {
    if (field !== key) values.push(obj.get(field) ?? null);
  }
  if (key !== undefined) {
    for (const group of groupsOf(obj, key)) {
      values.push(
        Object.keys(group)
          .filter((field) => group[field] !== undefined)
          .sort()
          .map((field) => [field, group[field]])
      );
    }
  }
  return JSON.stringify(values);
}

/** The reference lists a changed field reads from, or none. */
function readsFrom(definition: SlimType, change: FieldChange): readonly string[] {
  if (change.kind === 'field') return definition.p[change.field]?.ol ?? [];
  if (change.kind === 'group-field') return definition.x?.p[change.field]?.ol ?? [];
  return [];
}

function entersAny(definition: SlimType, lists: readonly string[]): boolean {
  const entered = definition.nref;
  return entered !== undefined && lists.some((list) => entered.includes(list));
}

/** The one rename a field change is the consequence of, or `undefined` when none or several fit. */
function attribute(
  definition: SlimType,
  change: FieldValueChange | GroupFieldChange,
  renames: readonly Rename[]
): Rename | undefined {
  const { before, after } = change;
  if (typeof before !== 'string' || typeof after !== 'string') return undefined;
  const lists = readsFrom(definition, change);
  if (lists.length === 0) return undefined;
  const from = before.toLowerCase();
  const to = after.toLowerCase();
  let found: Rename | undefined;
  for (const rename of renames) {
    if (rename.from !== from || rename.to !== to) continue;
    if (!lists.some((list) => rename.lists.has(list))) continue;
    if (found !== undefined) return undefined;
    found = rename;
  }
  return found;
}
