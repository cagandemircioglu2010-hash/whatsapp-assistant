import { describe, expect, it } from "vitest";
import { normalizeWhitelistUser } from "../scripts/whitelist-user.js";

describe("whitelist user normalization", () => {
  it("normalizes a valid record", () => {
    const user = normalizeWhitelistUser(
      { phone: "0555 111 22 33", name: "  Ada Lovelace  ", department: " Sales ", role: "manager", locale: "en", permissions: ["company.sales", " "] },
      "TR"
    );
    expect(user.phoneE164).toBe("+905551112233");
    expect(user.name).toBe("Ada Lovelace");
    expect(user.department).toBe("Sales");
    expect(user.role).toBe("manager");
    expect(user.locale).toBe("en");
    expect(user.permissions).toEqual(["company.sales"]);
  });

  it("defaults role to employee and locale to null", () => {
    const user = normalizeWhitelistUser({ phone: "+905551112233", name: "Grace" }, "TR");
    expect(user.role).toBe("employee");
    expect(user.locale).toBeNull();
    expect(user.permissions).toEqual([]);
  });

  it("labels the offending row on invalid input", () => {
    expect(() => normalizeWhitelistUser({ phone: "not-a-number", name: "X" }, "TR", "row 4")).toThrow(/row 4/);
    expect(() => normalizeWhitelistUser({ phone: "+905551112233", name: "A" }, "TR", "row 2")).toThrow(/row 2: name/);
    expect(() =>
      normalizeWhitelistUser({ phone: "+905551112233", name: "Ada", role: "root" }, "TR", "row 1")
    ).toThrow(/row 1: role/);
    expect(() =>
      normalizeWhitelistUser({ phone: "+905551112233", name: "Ada", permissions: ["company.secrets"] }, "TR", "row 3")
    ).toThrow(/row 3: permission/);
  });
});
