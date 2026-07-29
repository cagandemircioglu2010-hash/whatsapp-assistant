import { createHmac } from "node:crypto";
import Fastify, { type FastifyError } from "fastify";
import type { Logger } from "pino";
import { logSafe } from "../logging/logger.js";
import { timingSafeStringEqual } from "../whatsapp/signature.js";
import { adminStyles, renderAdminPage } from "./page.js";
import type { WhitelistAdminStore } from "./types.js";

type AdminAppDependencies = {
  store: WhitelistAdminStore;
  password: string;
  logger: Logger;
  production?: boolean;
};

type FormValue = string | string[];
type FormBody = Record<string, FormValue>;

type LoginBucket = {
  failures: number;
  resetAt: number;
  blockedUntil: number;
};

const allowedRoles = new Set(["employee", "manager", "executive", "admin"]);
const allowedLocales = new Set(["tr", "en"]);
const allowedPermissions = new Set([
  "company.sales",
  "company.projects",
  "company.tasks",
  "company.database.explore"
]);

function parseFormBody(raw: string): FormBody {
  const body: FormBody = Object.create(null) as FormBody;
  for (const [key, value] of new URLSearchParams(raw)) {
    if (!/^[a-z][a-z0-9_]{0,31}$/.test(key)) continue;
    const existing = body[key];
    if (existing === undefined) body[key] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else body[key] = [existing, value];
  }
  return body;
}

function one(body: FormBody, key: string, maxLength: number): string {
  const value = body[key];
  if (typeof value !== "string" || value.length > maxLength) {
    throw new Error(`Invalid ${key}`);
  }
  return value;
}

function many(body: FormBody, key: string): string[] {
  const value = body[key];
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function basicCredentials(header: string | undefined): { username: string; password: string } | null {
  if (!header?.startsWith("Basic ") || header.length > 2_048) return null;
  try {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator < 0) return null;
    return {
      username: decoded.slice(0, separator),
      password: decoded.slice(separator + 1)
    };
  } catch {
    return null;
  }
}

function safeInputMessage(error: unknown): string {
  if (!(error instanceof Error)) return "The request could not be completed.";
  const message = error.message;
  if (
    message.length <= 220 &&
    !/[\r\n]/.test(message) &&
    (/^user: /.test(message) ||
      /^Invalid (name|phone|department|role|locale|permissions)$/.test(message) ||
      message === "User identifier is invalid" ||
      message === "Whitelist user was not found")
  ) {
    return message.replace(/^user: /, "");
  }
  return "The request could not be completed. Check the form and try again.";
}

export async function buildWhitelistAdminApp(dependencies: AdminAppDependencies) {
  const app = Fastify({
    logger: false,
    bodyLimit: 16_384,
    requestTimeout: 15_000,
    connectionTimeout: 10_000,
    keepAliveTimeout: 72_000,
    trustProxy: dependencies.production === true
  });
  const loginBuckets = new Map<string, LoginBucket>();
  const csrfToken = createHmac("sha256", dependencies.password)
    .update("whitelist-admin-csrf-v1")
    .digest("base64url");

  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_request, body, done) => {
      try {
        done(null, parseFormBody(typeof body === "string" ? body : body.toString("utf8")));
      } catch (error) {
        done(error as Error, undefined);
      }
    }
  );

  app.addHook("onSend", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    reply.header(
      "Content-Security-Policy",
      "default-src 'none'; style-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
    );
    reply.header("Cross-Origin-Resource-Policy", "same-origin");
    reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("X-Permitted-Cross-Domain-Policies", "none");
    if (dependencies.production) {
      reply.header("Strict-Transport-Security", "max-age=31536000");
    }
  });

  app.addHook("onRequest", async (request, reply) => {
    if (request.url === "/health/live") return;
    if (dependencies.production && request.protocol !== "https") {
      return reply.code(400).send({ error: "HTTPS is required" });
    }
    if (
      request.method !== "GET" &&
      request.method !== "HEAD" &&
      request.headers["sec-fetch-site"] === "cross-site"
    ) {
      return reply.code(403).send({ error: "Cross-site request rejected" });
    }

    const now = Date.now();
    const bucket = loginBuckets.get(request.ip);
    if (bucket && bucket.blockedUntil > now) {
      reply.header("Retry-After", Math.ceil((bucket.blockedUntil - now) / 1000));
      return reply.code(429).send({ error: "Too many authentication attempts" });
    }

    const header = request.headers.authorization;
    const credentials = basicCredentials(Array.isArray(header) ? header[0] : header);
    const authenticated =
      credentials?.username === "admin" &&
      timingSafeStringEqual(credentials.password, dependencies.password);
    if (authenticated) {
      loginBuckets.delete(request.ip);
      return;
    }

    const current =
      bucket && bucket.resetAt > now
        ? bucket
        : { failures: 0, resetAt: now + 10 * 60_000, blockedUntil: 0 };
    current.failures += 1;
    if (current.failures >= 5) current.blockedUntil = now + 15 * 60_000;
    loginBuckets.set(request.ip, current);
    reply.header("WWW-Authenticate", 'Basic realm="WhatsApp whitelist", charset="UTF-8"');
    return reply.code(current.blockedUntil > now ? 429 : 401).send({ error: "Authentication required" });
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const requestedStatus = error.statusCode ?? 500;
    const status = requestedStatus >= 400 && requestedStatus < 500 ? requestedStatus : 500;
    if (status >= 500) {
      logSafe(
        dependencies.logger,
        "error",
        { error, requestId: request.id },
        "Whitelist admin request failed"
      );
    }
    return reply.code(status).send({
      error:
        status === 413
          ? "Request body is too large"
          : status === 415
            ? "Unsupported content type"
            : status >= 500
              ? "Internal server error"
              : "Invalid request"
    });
  });

  app.get("/health/live", async (_request, reply) => reply.send({ status: "ok" }));
  app.get("/admin.css", async (_request, reply) =>
    reply.type("text/css; charset=utf-8").send(adminStyles)
  );
  app.get<{ Querystring: { result?: string } }>("/", async (request, reply) => {
    const users = await dependencies.store.listUsers();
    return reply
      .type("text/html; charset=utf-8")
      .send(
        renderAdminPage({
          users,
          csrfToken,
          ...(request.query.result ? { result: request.query.result } : {})
        })
      );
  });

  app.post<{ Body: FormBody }>("/users", async (request, reply) => {
    const body = request.body;
    const suppliedCsrf = body?.csrf;
    if (
      typeof suppliedCsrf !== "string" ||
      suppliedCsrf.length > 128 ||
      !timingSafeStringEqual(suppliedCsrf, csrfToken)
    ) {
      return reply.code(403).send({ error: "Invalid form token" });
    }
    try {
      const role = one(body, "role", 16);
      const locale = one(body, "locale", 4);
      const permissions = many(body, "permissions");
      if (!allowedRoles.has(role)) throw new Error("Invalid role");
      if (!allowedLocales.has(locale)) throw new Error("Invalid locale");
      if (
        permissions.length > allowedPermissions.size ||
        permissions.some((permission) => !allowedPermissions.has(permission))
      ) {
        throw new Error("Invalid permissions");
      }
      const result = await dependencies.store.upsertUser({
        phone: one(body, "phone", 30),
        name: one(body, "name", 120),
        department: one(body, "department", 100),
        role,
        locale: locale as "tr" | "en",
        permissions
      });
      return reply.code(303).redirect(`/?result=${result.created ? "created" : "updated"}`);
    } catch (error) {
      const users = await dependencies.store.listUsers();
      return reply
        .code(400)
        .type("text/html; charset=utf-8")
        .send(renderAdminPage({ users, csrfToken, error: safeInputMessage(error) }));
    }
  });

  app.post<{ Params: { userId: string }; Body: FormBody }>(
    "/users/:userId/status",
    async (request, reply) => {
      const body = request.body;
      const suppliedCsrf = body?.csrf;
      if (
        typeof suppliedCsrf !== "string" ||
        suppliedCsrf.length > 128 ||
        !timingSafeStringEqual(suppliedCsrf, csrfToken)
      ) {
        return reply.code(403).send({ error: "Invalid form token" });
      }
      const activeValue = one(body, "active", 5);
      if (activeValue !== "true" && activeValue !== "false") {
        return reply.code(400).send({ error: "Invalid active state" });
      }
      await dependencies.store.setUserActive(request.params.userId, activeValue === "true");
      return reply
        .code(303)
        .redirect(`/?result=${activeValue === "true" ? "activated" : "deactivated"}`);
    }
  );

  return app;
}
