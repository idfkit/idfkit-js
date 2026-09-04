// Preamble, not shown on the page: the protocol's own shapes, and the two
// things an editor server already holds for the buffer it is serving.
//
// A real server imports the shapes from `vscode-languageserver` and gets the
// buffer from `vscode-languageserver-textdocument`. They are written out here
// so that this file depends on nothing but the service it translates, which is
// also the claim being made: the service names no protocol type, and wiring it
// into one is this file and nothing more.
import { classify, scanIdf, Severity } from '@idfkit/core';
import type {
  IdfDocument,
  ParseDiagnostic,
  ProsePool,
  Region,
  Schema,
  TokenKind,
  ValidationError,
} from '@idfkit/core';
import { completionsAt, declarationAt, explainAt, findingsIn } from '@idfkit/language';
import type { Offer, PositionedFinding } from '@idfkit/language';

interface Position {
  readonly line: number;
  readonly character: number;
}
interface Range {
  readonly start: Position;
  readonly end: Position;
}
interface TextEdit {
  readonly range: Range;
  readonly newText: string;
}
interface CompletionItem {
  readonly label: string;
  readonly kind: number;
  readonly detail: string | undefined;
  readonly documentation: string | undefined;
  readonly textEdit: TextEdit;
}
interface Hover {
  readonly contents: { readonly kind: 'markdown'; readonly value: string };
  readonly range: Range;
}
interface Location {
  readonly uri: string;
  readonly range: Range;
}
interface Diagnostic {
  readonly range: Range;
  readonly severity: number;
  readonly code: string | undefined;
  readonly message: string;
  readonly source: string;
}

/**
 * The open buffer, as the protocol library models it: its text, its URI, and
 * its own conversion from an offset to a protocol position. Every position in
 * this file comes out of `positionAt`, which is why none is computed here.
 */
declare const buffer: {
  getText(): string;
  positionAt(offset: number): Position;
  readonly uri: string;
};

/** The protocol library's token builder, which does the wire encoding. */
declare const tokens: { push(range: Range, type: string): void };

declare const schema: Schema;
declare const model: IdfDocument;
declare const prose: ProsePool;

// --8<-- [start:range]
const toRange = (region: Region): Range => ({
  start: buffer.positionAt(region.start),
  end: buffer.positionAt(region.end),
});
// --8<-- [end:range]

// --8<-- [start:tables]
/** The protocol's `CompletionItemKind` numbers, for the service's three kinds. */
const ITEM_KIND: Readonly<Record<Offer['kind'], number>> = {
  objectType: 7, // Class
  enumValue: 12, // Value
  referenceTarget: 18, // Reference
};

/** The protocol's `DiagnosticSeverity` numbers, for the three the corpus compares. */
const SEVERITY: Readonly<Record<Severity, number>> = {
  error: 1,
  warning: 2,
  info: 3,
};

/** Semantic token types, for the token kinds worth colouring. */
const TOKEN_TYPE: Readonly<Partial<Record<TokenKind, string>>> = {
  typeName: 'class',
  value: 'string',
  comment: 'comment',
};
// --8<-- [end:tables]

// --8<-- [start:completion]
function onCompletion(offset: number): CompletionItem[] {
  const result = completionsAt(buffer.getText(), offset, schema, { document: model, prose });
  if (result.status !== 'ok') return [];
  return result.offers.map((offer) => ({
    label: offer.value,
    kind: ITEM_KIND[offer.kind],
    detail: offer.required === true ? 'required' : undefined,
    documentation: offer.prose,
    // `replaces` is the service's answer, not this file's guess.
    textEdit: { range: toRange(offer.replaces), newText: offer.value },
  }));
}
// --8<-- [end:completion]

// --8<-- [start:hover]
function onHover(offset: number): Hover | null {
  const result = explainAt(buffer.getText(), offset, schema, prose);
  if (result.status !== 'ok') return null;
  const { explanation } = result;
  const parts = [
    `**${explanation.fieldName ?? explanation.typeName}**`,
    explanation.prose,
    explanation.field?.units === undefined ? undefined : `Units: ${explanation.field.units}`,
    explanation.docs === undefined
      ? undefined
      : `[${explanation.docs.label}](${explanation.docs.url})`,
  ];
  return {
    contents: { kind: 'markdown', value: parts.filter((part) => part !== undefined).join('\n\n') },
    range: toRange(explanation.region),
  };
}
// --8<-- [end:hover]

// --8<-- [start:definition]
function onDefinition(offset: number): Location[] {
  const result = declarationAt(buffer.getText(), offset, schema, model);
  if (result.status !== 'ok') return [];
  return result.declarations.map((declared) => ({
    uri: buffer.uri,
    range: toRange(declared.region),
  }));
}
// --8<-- [end:definition]

// --8<-- [start:diagnostics]
/** A reading finding carries no severity, because a file that will not read is an error. */
const severityOf = (finding: PositionedFinding<ParseDiagnostic | ValidationError>): Severity =>
  'severity' in finding ? finding.severity : Severity.ERROR;

function onDiagnostics(): Diagnostic[] {
  return findingsIn(buffer.getText(), schema).map((finding) => ({
    range: toRange(finding.region),
    severity: SEVERITY[severityOf(finding)],
    code: finding.code,
    message: finding.message,
    source: 'idfkit',
  }));
}
// --8<-- [end:diagnostics]

// --8<-- [start:highlight]
function onSemanticTokens(): void {
  for (const token of classify(scanIdf(buffer.getText()))) {
    const type = TOKEN_TYPE[token.kind];
    // `classify` has already split every region that crossed a newline, and it
    // covers the gaps between tokens too, so this loop neither looks for a
    // line boundary nor works out what it skipped.
    if (type !== undefined) tokens.push(toRange(token), type);
  }
}
// --8<-- [end:highlight]

// Not shown on the page: what the server registers these four as.
export { onCompletion, onDefinition, onDiagnostics, onHover, onSemanticTokens };
