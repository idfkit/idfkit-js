// `@idfkit/idfkit/node` is `@idfkit/core/node`: the filesystem half, kept behind its own
// subpath so a browser bundle that imports `@idfkit/idfkit` never reaches it (FR-038).
export * from '@idfkit/core/node';
