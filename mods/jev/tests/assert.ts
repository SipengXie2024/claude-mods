import { expect, test as kitTest } from 'claude-code/testing'

/**
 * node:assert/strict and node:test as the ported jev-opus tests use them, over
 * the kit's expect and test, so their bodies stay as written upstream.
 */
export const test = (name: string, body: () => unknown): void => kitTest(name, () => body())

const assert = {
  equal: (actual: unknown, expected: unknown, message?: string) => expect(actual, message).toBe(expected),
  notEqual: (actual: unknown, expected: unknown, message?: string) => expect(actual, message).not.toBe(expected),
  deepEqual: (actual: unknown, expected: unknown, message?: string) => expect(actual, message).toStrictEqual(expected),
  ok: (value: unknown, message?: string) => expect(Boolean(value), message).toBe(true),
  match: (actual: string, re: RegExp, message?: string) => expect(actual, message).toMatch(re),
  doesNotMatch: (actual: string, re: RegExp, message?: string) => expect(actual, message).not.toMatch(re),
}

export default assert
