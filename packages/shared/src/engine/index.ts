/**
 * TypeScript port of the app's adaptive TDEE engine (`lib/core/engine/`).
 * Pure: plain values in, plain values out, no I/O. fixtures/engine/ holds
 * golden vectors written by the Dart engine; test/engine.test.ts must
 * reproduce them.
 */
export * from './adaptive.js';
export * from './check-in.js';
export * from './local-date.js';
export * from './models.js';
export * from './program.js';
export * from './replay.js';
