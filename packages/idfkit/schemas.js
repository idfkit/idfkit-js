// `idfkit/schemas` is `@idfkit/schemas`. A plain dependency, so it is always
// installed, but behind its own subpath so its data is loaded on demand rather
// than dragged into every bundle (FR-038).
export * from '@idfkit/schemas';
