import { describe, expect, it, vi } from "vitest";
import { Client } from "pg";
import { assertLocalDatabase } from "../scripts/local-database";

describe("local database script guard", () => {
  it("uses the driver's effective host without connecting", () => {
    const connect = vi.spyOn(Client.prototype, "connect");
    expect(() => assertLocalDatabase("postgres://user:secret@localhost/app_test", true)).not.toThrow();
    expect(() => assertLocalDatabase("postgres://localhost/app_test?host=remote.example", true)).toThrow("non-local");
    expect(() => assertLocalDatabase("postgres://localhost/app_test?host=localhost&host=remote.example", true)).toThrow("non-local");
    expect(connect).not.toHaveBeenCalled();
  });

  it("restricts destructive integration checks to the test database", () => {
    expect(() => assertLocalDatabase("postgres://127.0.0.1/app", true)).toThrow("_test");
    expect(() => assertLocalDatabase("postgres://127.0.0.1/app")).not.toThrow();
  });

  it("never includes credentials in a refusal", () => {
    for (const url of ["postgres://user:secret@remote.example/app", "postgres://user:secret@[broken/app"]) {
      let error: unknown;
      try { assertLocalDatabase(url); } catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain("secret");
      expect((error as Error).message).not.toContain(url);
    }
  });
});
