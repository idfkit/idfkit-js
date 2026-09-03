// The shared install name's default entry point. Re-export only: the
// implementation is @idfkit/core, which stays published under its own name and
// remains the package this one depends on (FR-037).
export * from '@idfkit/core';
