/**
 * The key scheme is what separates two tenants, so the separation is asserted
 * on the keys themselves rather than only end-to-end: these are pure functions,
 * and a leak here is a leak everywhere the repository layer reads.
 *
 * `scripts/integration-check.ts` covers the same property against a real table,
 * where a GSI listing can actually return the other tenant's rows.
 */

import { describe, expect, it } from "vitest";
import { keys } from "@/infrastructure/db/keys";
import { DEFAULT_TENANT, currentTenant, withTenant } from "@/shared/tenantContext";

describe("tenant key scope", () => {
  it("gives the default tenant no prefix, so existing rows keep their keys", () => {
    expect(keys.project(DEFAULT_TENANT, "bot")).toEqual({ PK: "PROJECT#bot", SK: "META" });
    expect(keys.typePartition(DEFAULT_TENANT, "PROJECT")).toBe("TYPE#PROJECT");
    expect(keys.usageDatePartition(DEFAULT_TENANT, "2026-08-01")).toBe("USAGEDATE#2026-08-01");
  });

  it("separates the same name in two tenants", () => {
    expect(keys.project("alpha", "bot").PK).not.toBe(keys.project("beta", "bot").PK);
    expect(keys.chat("alpha", "c1").PK).not.toBe(keys.chat("beta", "c1").PK);
    expect(keys.skill("alpha", "s").PK).not.toBe(keys.skill("beta", "s").PK);
  });

  it("scopes the GSI partitions too, not only the primary key", () => {
    // A scheme that scoped only `PK` would still hand both tenants' projects to
    // one `TYPE#PROJECT` listing — the leak is in the index, not the item.
    expect(keys.typePartition("alpha", "PROJECT")).not.toBe(keys.typePartition("beta", "PROJECT"));
    expect(keys.chatOwnerPartition("alpha", "a@x.com")).not.toBe(
      keys.chatOwnerPartition("beta", "a@x.com"),
    );
    expect(keys.usageDatePartition("alpha", "2026-08-01")).not.toBe(
      keys.usageDatePartition("beta", "2026-08-01"),
    );
    expect(keys.traceProjectPartition("alpha", "bot")).not.toBe(
      keys.traceProjectPartition("beta", "bot"),
    );
    expect(keys.scheduleIndex("alpha", "bot", "t").GSI1PK).not.toBe(
      keys.scheduleIndex("beta", "bot", "t").GSI1PK,
    );
  });

  it("keeps a tenant's rows under one readable prefix", () => {
    expect(keys.project("alpha", "bot").PK).toBe("T#alpha#PROJECT#bot");
    expect(keys.runSlot("alpha", "user:a@x.com", 0).PK).toBe("T#alpha#RUNSLOT#user:a@x.com");
  });

  it("leaves the rows that belong to no tenant alone", () => {
    // A person may belong to several tenants; the settings row is
    // infrastructure; the organization row is what names the tenants.
    expect(keys.auth("user", "u1").PK).toBe("AUTH#user#u1");
    expect(keys.settings().PK).toBe("SETTINGS#app");
    expect(keys.organization("alpha").PK).toBe("ORG#alpha");
  });
});

describe("tenant context", () => {
  it("is the default tenant until something says otherwise", () => {
    expect(currentTenant()).toBe(DEFAULT_TENANT);
  });

  it("scopes everything the callback awaits, however deep", async () => {
    const seen = await withTenant("alpha", async () => {
      await Promise.resolve();
      return (async () => currentTenant())();
    });
    expect(seen).toBe("alpha");
    expect(currentTenant()).toBe(DEFAULT_TENANT);
  });

  it("nests, so a tenant-scoped job inside another does not inherit the outer one", async () => {
    const inner = await withTenant("alpha", () => withTenant("beta", async () => currentTenant()));
    expect(inner).toBe("beta");
  });
});
