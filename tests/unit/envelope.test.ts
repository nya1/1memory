import { describe, expect, it } from "vitest";
import { failure, success } from "../../src/core/envelope.js";
import { JustMemoryError } from "../../src/core/errors.js";

describe("response envelopes", () => {
  it("creates successful envelopes with schema and request id", () => {
    const envelope = success({ hello: "world" });

    expect(envelope.ok).toBe(true);
    expect(envelope.schema_version).toBe("2026-04-v1-local-alpha");
    expect(envelope.request_id).toMatch(/^req_/);
    expect(envelope.data).toEqual({ hello: "world" });
    expect(envelope.errors).toEqual([]);
  });

  it("maps known errors into stable failure envelopes", () => {
    const envelope = failure(
      new JustMemoryError("profile_not_found", "Profile does not exist.", "Choose another profile.")
    );

    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe("profile_not_found");
    expect(envelope.error.action).toBe("Choose another profile.");
  });
});
