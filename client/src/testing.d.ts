// The slice of node's test runner the tests here actually use.
//
// Hand-written rather than `@types/node`, which would be the fourth dependency
// in a project whose rule is "could this be 40 lines instead" — and this is
// twenty. It is also the honest scope: these tests run against pure functions,
// so nothing here needs `fs`, `process`, or the DOM-shaped half of node's types
// that would start overlapping `lib.dom`.
//
// `test.mjs` is what supplies the real implementations; nothing in `src` imports
// these at runtime except a `*.test.ts`, and none of those are reachable from
// `main.ts`, so none of it reaches the bundle the browser gets.

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
