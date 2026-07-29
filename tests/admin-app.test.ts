import { afterEach, describe, expect, it } from "vitest";
import { buildWhitelistAdminApp } from "../src/admin/app.js";
import type {
  AdminUpsertResult,
  AdminWhitelistUser,
  WhitelistAdminStore
} from "../src/admin/types.js";
import type { WhitelistUserInput } from "../scripts/whitelist-user.js";
import { createLogger } from "../src/logging/logger.js";

const password = "test-password-".repeat(3);
const authorization = `Basic ${Buffer.from(`admin:${password}`).toString("base64")}`;
const apps: Array<Awaited<ReturnType<typeof buildWhitelistAdminApp>>> = [];

class FakeStore implements WhitelistAdminStore {
  users: AdminWhitelistUser[] = [
    {
      id: "6dff4e16-bc44-4d25-9dd8-d2a81d761227",
      name: 'Ada <script>alert("x")</script>',
      phoneMasked: "+905******875",
      department: "Sales",
      role: "employee",
      locale: "tr",
      active: true,
      permissions: [],
      createdAt: new Date("2026-07-29T10:00:00Z")
    }
  ];
  upserts: WhitelistUserInput[] = [];
  statusChanges: Array<{ userId: string; active: boolean }> = [];

  async listUsers(): Promise<AdminWhitelistUser[]> {
    return this.users;
  }

  async upsertUser(input: WhitelistUserInput): Promise<AdminUpsertResult> {
    this.upserts.push(input);
    return { created: true };
  }

  async setUserActive(userId: string, active: boolean): Promise<void> {
    this.statusChanges.push({ userId, active });
  }
}

async function app(store = new FakeStore()) {
  const instance = await buildWhitelistAdminApp({
    store,
    password,
    logger: createLogger("silent")
  });
  apps.push(instance);
  return { instance, store };
}

function csrfFrom(html: string): string {
  const token = html.match(/name="csrf" value="([^"]+)"/)?.[1];
  if (!token) throw new Error("CSRF token missing from page");
  return token;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((instance) => instance.close()));
});

describe("whitelist administration HTTP app", () => {
  it("keeps liveness and styles public and sends signed-out users to the login page", async () => {
    const { instance } = await app();
    const health = await instance.inject({ method: "GET", url: "/health/live" });
    const page = await instance.inject({ method: "GET", url: "/" });
    const css = await instance.inject({ method: "GET", url: "/admin.css" });
    const login = await instance.inject({ method: "GET", url: "/login" });

    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: "ok" });
    expect(page.statusCode).toBe(303);
    expect(page.headers.location).toBe("/login");
    expect(css.statusCode).toBe(200);
    expect(login.statusCode).toBe(200);
    expect(login.body).toContain("Admin sign in");
    expect(login.body).toContain('type="password"');
    expect(login.body).not.toContain(password);
  });

  it("does not count normal login-page visits as password failures", async () => {
    const { instance } = await app();
    for (let visit = 0; visit < 20; visit += 1) {
      const response = await instance.inject({ method: "GET", url: "/" });
      expect(response.statusCode).toBe(303);
    }

    const loginPage = await instance.inject({ method: "GET", url: "/login" });
    const login = await instance.inject({
      method: "POST",
      url: "/login",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        csrf: csrfFrom(loginPage.body),
        password
      }).toString()
    });

    expect(login.statusCode).toBe(303);
    expect(login.headers.location).toBe("/");
    expect(login.headers["set-cookie"]).toContain("wa_admin_session=");
  });

  it("does not use Basic authorization as an alternate password probe on the public login route", async () => {
    const { instance } = await app();
    const response = await instance.inject({
      method: "GET",
      url: "/login",
      headers: { authorization }
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Admin sign in");
    expect(response.headers.location).toBeUndefined();
  });

  it("renders only masked phones, escapes identity fields, and sends defensive headers", async () => {
    const { instance } = await app();
    const response = await instance.inject({
      method: "GET",
      url: "/",
      headers: { authorization }
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["content-security-policy"]).toContain("form-action 'self'");
    expect(response.headers["strict-transport-security"]).toBeUndefined();
    expect(response.body).toContain("+905******875");
    expect(response.body).not.toContain("+905305566875");
    expect(response.body).toContain("Ada &lt;script&gt;");
    expect(response.body).not.toContain('<script>alert("x")</script>');
    expect(response.body).toContain("No company-data access");
    expect(response.body).toContain("Sign out");
  });

  it("creates an HTTP-only session, authenticates with it, and revokes it on sign-out", async () => {
    const { instance } = await app();
    const loginPage = await instance.inject({ method: "GET", url: "/login" });
    const login = await instance.inject({
      method: "POST",
      url: "/login",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        csrf: csrfFrom(loginPage.body),
        password
      }).toString()
    });
    const setCookie = login.headers["set-cookie"];

    expect(login.statusCode).toBe(303);
    expect(setCookie).toContain("wa_admin_session=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).not.toContain("Secure");
    const cookie = (setCookie as string).split(";", 1)[0]!;

    const page = await instance.inject({
      method: "GET",
      url: "/",
      headers: { cookie }
    });
    expect(page.statusCode).toBe(200);
    const logout = await instance.inject({
      method: "POST",
      url: "/logout",
      headers: {
        cookie,
        "content-type": "application/x-www-form-urlencoded"
      },
      payload: new URLSearchParams({ csrf: csrfFrom(page.body) }).toString()
    });
    expect(logout.statusCode).toBe(303);
    expect(logout.headers.location).toBe("/login");
    expect(logout.headers["set-cookie"]).toContain("Max-Age=0");

    const afterLogout = await instance.inject({
      method: "GET",
      url: "/",
      headers: { cookie }
    });
    expect(afterLogout.statusCode).toBe(303);
    expect(afterLogout.headers.location).toBe("/login");
  });

  it("requires HTTPS and marks the session cookie Secure in production", async () => {
    const instance = await buildWhitelistAdminApp({
      store: new FakeStore(),
      password,
      logger: createLogger("silent"),
      production: true
    });
    apps.push(instance);

    const insecure = await instance.inject({ method: "GET", url: "/login" });
    expect(insecure.statusCode).toBe(400);

    const secureHeaders = { "x-forwarded-proto": "https" };
    const loginPage = await instance.inject({
      method: "GET",
      url: "/login",
      headers: secureHeaders
    });
    expect(loginPage.statusCode).toBe(200);
    expect(loginPage.headers["strict-transport-security"]).toBe("max-age=31536000");

    const login = await instance.inject({
      method: "POST",
      url: "/login",
      headers: {
        ...secureHeaders,
        "content-type": "application/x-www-form-urlencoded"
      },
      payload: new URLSearchParams({
        csrf: csrfFrom(loginPage.body),
        password
      }).toString()
    });
    expect(login.statusCode).toBe(303);
    expect(login.headers["set-cookie"]).toContain("Secure");
  });

  it("adds a user through a CSRF-protected form without putting identity data in the redirect", async () => {
    const { instance, store } = await app();
    const page = await instance.inject({
      method: "GET",
      url: "/",
      headers: { authorization }
    });
    const csrf = csrfFrom(page.body);
    const payload = new URLSearchParams([
      ["csrf", csrf],
      ["name", "New Tester"],
      ["phone", "+90 530 111 22 33"],
      ["department", "Sales"],
      ["role", "manager"],
      ["locale", "tr"],
      ["permissions", "company.sales"],
      ["permissions", "company.projects"]
    ]).toString();

    const response = await instance.inject({
      method: "POST",
      url: "/users",
      headers: {
        authorization,
        "content-type": "application/x-www-form-urlencoded"
      },
      payload
    });

    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe("/?result=created");
    expect(response.headers.location).not.toContain("90530");
    expect(store.upserts).toEqual([
      {
        phone: "+90 530 111 22 33",
        name: "New Tester",
        department: "Sales",
        role: "manager",
        locale: "tr",
        permissions: ["company.sales", "company.projects"]
      }
    ]);
  });

  it("rejects missing form tokens, unknown permissions, and cross-site mutations", async () => {
    const { instance, store } = await app();
    const missingToken = await instance.inject({
      method: "POST",
      url: "/users",
      headers: {
        authorization,
        "content-type": "application/x-www-form-urlencoded"
      },
      payload: "name=Tester"
    });
    expect(missingToken.statusCode).toBe(403);

    const page = await instance.inject({
      method: "GET",
      url: "/",
      headers: { authorization }
    });
    const csrf = csrfFrom(page.body);
    const invalidPermission = await instance.inject({
      method: "POST",
      url: "/users",
      headers: {
        authorization,
        "content-type": "application/x-www-form-urlencoded"
      },
      payload: new URLSearchParams({
        csrf,
        name: "Tester",
        phone: "+905301112233",
        department: "",
        role: "employee",
        locale: "tr",
        permissions: "company.secret"
      }).toString()
    });
    expect(invalidPermission.statusCode).toBe(400);
    expect(invalidPermission.body).toContain("Invalid permissions");

    const crossSite = await instance.inject({
      method: "POST",
      url: "/users",
      headers: {
        authorization,
        "content-type": "application/x-www-form-urlencoded",
        "sec-fetch-site": "cross-site"
      },
      payload: `csrf=${encodeURIComponent(csrf)}`
    });
    expect(crossSite.statusCode).toBe(403);
    expect(store.upserts).toHaveLength(0);
  });

  it("activates and deactivates by opaque user ID", async () => {
    const { instance, store } = await app();
    const page = await instance.inject({
      method: "GET",
      url: "/",
      headers: { authorization }
    });
    const csrf = csrfFrom(page.body);
    const response = await instance.inject({
      method: "POST",
      url: "/users/6dff4e16-bc44-4d25-9dd8-d2a81d761227/status",
      headers: {
        authorization,
        "content-type": "application/x-www-form-urlencoded"
      },
      payload: new URLSearchParams({ csrf, active: "false" }).toString()
    });

    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe("/?result=deactivated");
    expect(store.statusChanges).toEqual([
      { userId: "6dff4e16-bc44-4d25-9dd8-d2a81d761227", active: false }
    ]);
  });

  it("temporarily blocks repeated invalid passwords", async () => {
    const { instance } = await app();
    const invalidAuthorization = `Basic ${Buffer.from("admin:wrong").toString("base64")}`;
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await instance.inject({
        method: "GET",
        url: "/",
        headers: { authorization: invalidAuthorization }
      });
      statuses.push(response.statusCode);
    }
    expect(statuses.slice(0, 4)).toEqual([401, 401, 401, 401]);
    expect(statuses[4]).toBe(429);

    const recovered = await instance.inject({
      method: "GET",
      url: "/",
      headers: { authorization }
    });
    expect(recovered.statusCode).toBe(200);
  });

  it("shows failed login attempts in the login page and accepts the correct password during a lockout", async () => {
    const { instance } = await app();
    const loginPage = await instance.inject({ method: "GET", url: "/login" });
    const csrf = csrfFrom(loginPage.body);
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await instance.inject({
        method: "POST",
        url: "/login",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: new URLSearchParams({ csrf, password: "wrong password" }).toString()
      });
      statuses.push(response.statusCode);
      expect(response.headers["content-type"]).toContain("text/html");
      expect(response.body).toContain(
        attempt === 4 ? "Too many incorrect attempts" : "The password is incorrect"
      );
    }
    expect(statuses).toEqual([401, 401, 401, 401, 429]);

    const recovered = await instance.inject({
      method: "POST",
      url: "/login",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ csrf, password }).toString()
    });
    expect(recovered.statusCode).toBe(303);
    expect(recovered.headers["set-cookie"]).toContain("wa_admin_session=");
  });

  it("rejects login CSRF and cross-site login attempts without creating a session", async () => {
    const { instance } = await app();
    const invalidToken = await instance.inject({
      method: "POST",
      url: "/login",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ csrf: "wrong", password }).toString()
    });
    expect(invalidToken.statusCode).toBe(403);
    expect(invalidToken.headers["set-cookie"]).toBeUndefined();

    const loginPage = await instance.inject({ method: "GET", url: "/login" });
    const crossSite = await instance.inject({
      method: "POST",
      url: "/login",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "sec-fetch-site": "cross-site"
      },
      payload: new URLSearchParams({
        csrf: csrfFrom(loginPage.body),
        password
      }).toString()
    });
    expect(crossSite.statusCode).toBe(403);
    expect(crossSite.headers["set-cookie"]).toBeUndefined();
  });
});
