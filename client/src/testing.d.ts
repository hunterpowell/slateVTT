// The slice of node's test runner the tests here actually use.
//
// Hand-written instead of `@types/node`, which would be a third dependency in a
// project whose rule is "could this be 40 lines instead", and this is twenty.
// It also matches what the tests need: they run against pure functions, so
// nothing here needs `fs`, `process`, or the half of node's types that would
// start overlapping `lib.dom`.
//
// `test.mjs` supplies the real implementations. Nothing in `src` imports these
// at runtime except a `*.test.ts`, and none of those are reachable from
// `main.ts`, so none of it reaches the browser's bundle.

declare module 'node:test' {
  export function test(name: string, fn: () => void | Promise<void>): void;
}

declare module 'node:assert/strict' {
  interface Assert {
    /** No `asserts value` on any of these: narrowing would make every call site
     *  need an explicit type annotation, and these are tests, not proofs. */
    ok(value: unknown, message?: string): void;
    equal(actual: unknown, expected: unknown, message?: string): void;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
  }
  const assert: Assert;
  export default assert;
}
