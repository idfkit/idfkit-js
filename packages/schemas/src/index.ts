import { BlobStore, Schema } from './schema.js';
import type { BundleIndex, Manifest, SlimType } from './types.js';

export { BlobStore, Schema } from './schema.js';
export type { SchemaDelta } from './schema.js';
export type {
  BundleIndex,
  FieldKind,
  Manifest,
  SlimExtensible,
  SlimField,
  SlimType,
} from './types.js';

/**
 * Where bundle files come from.
 *
 * The only runtime-specific part of this package. Node reads from disk, the
 * browser fetches over HTTP, and a bundler-driven app can supply its own
 * resolver backed by `import()`. Everything above this interface is portable.
 */
export interface BundleSource {
  read(fileName: string): Promise<unknown>;
}

/**
 * Fetch-based source, for browsers and any runtime with global `fetch`.
 *
 * Reads the gzipped bundle and inflates it with `DecompressionStream`, which is
 * baseline-available in browsers. That keeps the served payload at roughly 1 MB
 * for all 17 versions instead of the ~6 MB the raw JSON would cost.
 *
 * The payload is sniffed for the gzip magic bytes before inflating. A host that
 * maps the `.gz` extension to `Content-Encoding: gzip` (Vite's dev server,
 * nginx with `gzip_static on`, and several static hosts) makes the HTTP client
 * inflate the body itself, leaving plain JSON with nothing left to decompress.
 * Feeding that to `DecompressionStream` fails with an opaque `incorrect header
 * check`, so we only decompress when the bytes actually start with `1f 8b`.
 */
export function httpSource(baseUrl: string): BundleSource {
  // Resolve against the document base when there is one, so a same-origin
  // path like '/schemas/' works the way `fetch('/schemas/...')` does. In Node
  // there is no base, and a relative path stays an error — it cannot resolve.
  // Resolution is deferred to `read` so that merely constructing the source
  // (e.g. `new SchemaBundle(httpSource('/schemas/'))` at module scope in an
  // isomorphic app) never throws on the server; the error only surfaces if a
  // relative base is actually read where it cannot resolve.
  const normalized = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return {
    async read(fileName) {
      const documentBase = (globalThis as { location?: { href: string } }).location?.href;
      const base = new URL(normalized, documentBase).href;
      const response = await fetch(new URL(`${fileName}.gz`, base));
      if (!response.ok) {
        throw new Error(`Failed to load ${fileName}.gz: ${response.status} ${response.statusText}`);
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length === 0) {
        throw new Error(`Empty response for ${fileName}.gz`);
      }
      // The client already inflated the body (host set Content-Encoding: gzip).
      if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) {
        return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
      }
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
      return JSON.parse(await new Response(stream).text()) as unknown;
    },
  };
}

/**
 * Loads schemas from a bundle, sharing one blob store across every version.
 *
 * Hold one of these for the lifetime of the process. Loading 26.1.0 and then
 * 9.4.0 costs far less than twice one version, because most definitions are
 * byte-identical and already hydrated.
 */
export class SchemaBundle {
  #source: BundleSource;
  #index: BundleIndex | undefined;
  #store: BlobStore | undefined;
  #schemas = new Map<string, Schema>();
  /** In-flight loads, so concurrent callers share one request. */
  #pending = new Map<string, Promise<Schema>>();

  constructor(source: BundleSource) {
    this.#source = source;
  }

  /** Versions this bundle can serve, oldest first. */
  async versions(): Promise<readonly string[]> {
    return (await this.#loadIndex()).versions;
  }

  /** The newest version in the bundle. */
  async latest(): Promise<string> {
    const versions = await this.versions();
    const last = versions.at(-1);
    if (last === undefined) throw new Error('Schema bundle contains no versions');
    return last;
  }

  /**
   * Load one version's schema.
   *
   * Repeat calls return the same instance; concurrent calls share one fetch.
   */
  async load(version: string): Promise<Schema> {
    const cached = this.#schemas.get(version);
    if (cached !== undefined) return cached;

    const inFlight = this.#pending.get(version);
    if (inFlight !== undefined) return inFlight;

    const promise = this.#load(version).finally(() => this.#pending.delete(version));
    this.#pending.set(version, promise);
    return promise;
  }

  /** A version already loaded, or undefined. Synchronous by design. */
  loaded(version: string): Schema | undefined {
    return this.#schemas.get(version);
  }

  async #load(version: string): Promise<Schema> {
    const index = await this.#loadIndex();
    const fileName = index.manifests[version];
    if (fileName === undefined) {
      throw new Error(
        `EnergyPlus ${version} is not in this bundle. Available: ${index.versions.join(', ')}`
      );
    }

    if (this.#store === undefined) {
      const raw = (await this.#source.read('types.json')) as Record<string, SlimType>;
      this.#store ??= new BlobStore(raw);
    }

    const manifest = (await this.#source.read(fileName)) as Manifest;
    const schema = new Schema(version, manifest, this.#store);
    this.#schemas.set(version, schema);
    return schema;
  }

  async #loadIndex(): Promise<BundleIndex> {
    this.#index ??= (await this.#source.read('index.json')) as BundleIndex;
    return this.#index;
  }
}
