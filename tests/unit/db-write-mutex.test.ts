import { describe, expect, it } from "vitest";
import { withDbWriteLock } from "../../src/storage/db-write-mutex.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("withDbWriteLock", () => {
  it("runs mutations strictly one at a time", async () => {
    const order: number[] = [];
    const a = withDbWriteLock(async () => {
      order.push(1);
      await delay(15);
      order.push(2);
    });
    const b = withDbWriteLock(async () => {
      order.push(3);
    });
    await Promise.all([a, b]);
    expect(order).toEqual([1, 2, 3]);
  });
});
