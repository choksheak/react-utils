import { stringifyDeterministicForKeys } from "./stringify";

describe("stringifyDeterministicForKeys", () => {
  test("happy", () => {
    const expected = `{"a":1,"b":2,"c":{"e":1,"f":2}}`;

    const actual1 = stringifyDeterministicForKeys({
      a: 1,
      b: 2,
      c: { e: 1, f: 2 },
    });
    expect(actual1).toBe(expected);

    const actual2 = stringifyDeterministicForKeys({
      c: { f: 2, e: 1 },
      b: 2,
      a: 1,
    });
    expect(actual2).toBe(expected);
  });

  test("circular", () => {
    const circular = { b: {}, a: 1 };
    circular.b = circular;

    const actual = stringifyDeterministicForKeys(circular);

    expect(actual).toBe(`{"a":1,"b":"[Circular]"}`);
  });

  test("function", () => {
    const fn = { b: {}, a: () => {} };

    expect(() => stringifyDeterministicForKeys(fn)).toThrow(
      `Functions should not be passed into query parameters`,
    );
  });

  test("array", () => {
    const a = [1, "a", { b: 2 }, [true]];

    const actual = stringifyDeterministicForKeys(a);

    expect(actual).toBe(`[1,"a",{"b":2},[true]]`);
  });
});
