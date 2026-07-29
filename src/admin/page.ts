import type { AdminWhitelistUser } from "./types.js";

const permissionLabels: Readonly<Record<string, string>> = {
  "company.sales": "Sales reports",
  "company.projects": "Project reports",
  "company.tasks": "Task reports",
  "company.database.explore": "Approved database explorer"
};

export const adminStyles = `
:root {
  color-scheme: light;
  --ink: #102a2b;
  --muted: #5c6f6f;
  --line: #dfe8e4;
  --paper: #ffffff;
  --wash: #f3f7f5;
  --brand: #0b6b58;
  --brand-dark: #075044;
  --danger: #a4392e;
  --danger-wash: #fff0ed;
  --success: #176b45;
  --success-wash: #eaf7ef;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  min-width: 320px;
  color: var(--ink);
  background:
    radial-gradient(circle at 90% -10%, #d4eee6 0, transparent 38rem),
    var(--wash);
}
button, input, select { font: inherit; }
a { color: inherit; }
.shell { width: min(1180px, calc(100% - 32px)); margin: 0 auto; padding: 42px 0 64px; }
.topbar { display: flex; justify-content: space-between; gap: 24px; align-items: flex-end; margin-bottom: 26px; }
.top-actions { display: flex; flex: none; align-items: center; gap: 9px; }
.eyebrow { margin: 0 0 7px; color: var(--brand); font-size: 12px; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; }
h1 { margin: 0; font-size: clamp(28px, 5vw, 46px); line-height: 1.03; letter-spacing: -.045em; }
.subtitle { max-width: 650px; margin: 12px 0 0; color: var(--muted); line-height: 1.55; }
.secure { flex: none; border: 1px solid #bcd9cf; background: #e8f5f0; color: var(--brand-dark); border-radius: 99px; padding: 8px 12px; font-size: 12px; font-weight: 750; }
.notice { margin: 0 0 20px; border-radius: 12px; padding: 13px 15px; font-weight: 650; }
.notice.success { color: var(--success); background: var(--success-wash); border: 1px solid #bfe5ce; }
.notice.error { color: var(--danger); background: var(--danger-wash); border: 1px solid #f0c2ba; }
.grid { display: grid; grid-template-columns: minmax(300px, .72fr) minmax(500px, 1.28fr); gap: 20px; align-items: start; }
.card { border: 1px solid var(--line); border-radius: 18px; background: var(--paper); box-shadow: 0 16px 45px rgba(31, 65, 57, .07); overflow: hidden; }
.card-head { padding: 22px 24px 0; }
.card-head h2 { margin: 0; font-size: 20px; letter-spacing: -.02em; }
.card-head p { margin: 7px 0 0; color: var(--muted); font-size: 14px; line-height: 1.5; }
.form { padding: 21px 24px 24px; }
.field { display: grid; gap: 7px; margin-bottom: 15px; }
.field-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
label, legend { font-size: 13px; font-weight: 750; }
input[type="text"], input[type="tel"], input[type="password"], select {
  width: 100%; min-height: 44px; border: 1px solid #cbd9d4; border-radius: 10px; padding: 10px 12px;
  color: var(--ink); background: #fff; outline: none;
}
input:focus, select:focus { border-color: var(--brand); box-shadow: 0 0 0 3px rgba(11, 107, 88, .12); }
fieldset { border: 0; padding: 0; margin: 18px 0; }
.checks { display: grid; gap: 9px; margin-top: 10px; }
.check { display: flex; align-items: flex-start; gap: 9px; color: #314d4d; font-size: 13px; font-weight: 600; }
.check input { margin: 2px 0 0; accent-color: var(--brand); }
.hint { margin: 9px 0 0; color: var(--muted); font-size: 12px; line-height: 1.45; }
.primary, .toggle {
  border: 0; border-radius: 10px; cursor: pointer; font-weight: 800;
}
.primary { width: 100%; min-height: 46px; color: #fff; background: var(--brand); }
.primary:hover { background: var(--brand-dark); }
.logout { border: 1px solid #c7ded6; border-radius: 99px; padding: 7px 11px; color: var(--brand-dark); background: #fff; cursor: pointer; font-size: 12px; font-weight: 750; }
.logout:hover { background: #edf7f3; }
.login-shell { width: min(460px, calc(100% - 28px)); margin: 0 auto; padding: max(56px, 12vh) 0 64px; }
.login-card { border: 1px solid var(--line); border-radius: 20px; padding: 28px; background: var(--paper); box-shadow: 0 22px 65px rgba(31, 65, 57, .11); }
.login-card h1 { font-size: clamp(30px, 8vw, 42px); }
.login-card .subtitle { margin-bottom: 22px; }
.login-card .field { margin-bottom: 18px; }
.login-card .footer { margin-bottom: 0; }
.users { padding: 8px 18px 18px; }
.empty { margin: 12px 6px 4px; border: 1px dashed #c9d8d3; border-radius: 12px; padding: 30px 18px; text-align: center; color: var(--muted); }
.user { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 16px; padding: 17px 6px; border-bottom: 1px solid var(--line); }
.user:last-child { border-bottom: 0; }
.identity { min-width: 0; }
.name-line { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.name { font-weight: 820; overflow-wrap: anywhere; }
.badge { border-radius: 99px; padding: 4px 8px; font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: .04em; }
.badge.active { color: var(--success); background: var(--success-wash); }
.badge.inactive { color: var(--danger); background: var(--danger-wash); }
.meta { margin-top: 6px; color: var(--muted); font-size: 13px; line-height: 1.5; overflow-wrap: anywhere; }
.perms { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 9px; }
.perm { border: 1px solid #d6e4df; border-radius: 7px; padding: 4px 7px; color: #3a5955; background: #f8fbfa; font-size: 11px; }
.perm.none { color: #7c6661; background: #fff8f6; border-color: #eed9d4; }
.action { display: flex; align-items: center; }
.toggle { min-width: 92px; padding: 9px 11px; color: var(--brand-dark); background: #e9f4f0; border: 1px solid #c7ded6; }
.toggle.danger { color: var(--danger); background: var(--danger-wash); border-color: #ebc8c1; }
.footer { margin-top: 18px; color: var(--muted); font-size: 12px; line-height: 1.5; text-align: center; }
@media (max-width: 850px) {
  .grid { grid-template-columns: 1fr; }
  .topbar { align-items: flex-start; flex-direction: column; }
  .top-actions { width: 100%; justify-content: space-between; }
}
@media (max-width: 540px) {
  .shell { width: min(100% - 20px, 1180px); padding-top: 24px; }
  .field-row { grid-template-columns: 1fr; gap: 0; }
  .card-head, .form { padding-left: 18px; padding-right: 18px; }
  .user { grid-template-columns: 1fr; }
  .action, .toggle { width: 100%; }
}
`;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function permissionName(permission: string): string {
  return permissionLabels[permission] ?? permission;
}

function resultNotice(result: string | undefined): string {
  const messages: Readonly<Record<string, string>> = {
    created: "User added to the whitelist.",
    updated: "Existing user updated and reactivated.",
    activated: "User activated.",
    deactivated: "User deactivated."
  };
  const message = result ? messages[result] : undefined;
  return message
    ? `<div class="notice success" role="status">${escapeHtml(message)}</div>`
    : "";
}

export function renderLoginPage(input: {
  csrfToken: string;
  error?: string | undefined;
}): string {
  const error = input.error
    ? `<div class="notice error" role="alert">${escapeHtml(input.error)}</div>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow, noarchive">
  <title>Sign in · Whitelist administration</title>
  <link rel="stylesheet" href="/admin.css">
</head>
<body>
  <main class="login-shell">
    <section class="login-card" aria-labelledby="login-title">
      <p class="eyebrow">WhatsApp assistant</p>
      <h1 id="login-title">Admin sign in</h1>
      <p class="subtitle">Enter the password stored in Render as <strong>WHITELIST_ADMIN_PASSWORD</strong>.</p>
      ${error}
      <form method="post" action="/login">
        <input type="hidden" name="csrf" value="${escapeHtml(input.csrfToken)}">
        <div class="field">
          <label for="password">Admin password</label>
          <input id="password" name="password" type="password" minlength="32" maxlength="512" autocomplete="current-password" autofocus required>
        </div>
        <button class="primary" type="submit">Sign in securely</button>
      </form>
      <p class="footer">The app does not place the password in browser storage. Your session is protected by a secure, HTTP-only cookie.</p>
    </section>
  </main>
</body>
</html>`;
}

function userCard(user: AdminWhitelistUser, csrfToken: string): string {
  const permissions =
    user.permissions.length > 0
      ? user.permissions
          .map(
            (permission) =>
              `<span class="perm">${escapeHtml(permissionName(permission))}</span>`
          )
          .join("")
      : '<span class="perm none">No company-data access</span>';
  const nextActive = user.active ? "false" : "true";
  return `<article class="user">
    <div class="identity">
      <div class="name-line">
        <span class="name">${escapeHtml(user.name)}</span>
        <span class="badge ${user.active ? "active" : "inactive"}">${user.active ? "Active" : "Inactive"}</span>
      </div>
      <div class="meta">
        ${escapeHtml(user.phoneMasked)} · ${escapeHtml(user.role)}
        ${user.department ? ` · ${escapeHtml(user.department)}` : ""}
        · ${(user.locale ?? "default").toUpperCase()}
      </div>
      <div class="perms">${permissions}</div>
    </div>
    <form class="action" method="post" action="/users/${encodeURIComponent(user.id)}/status">
      <input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}">
      <input type="hidden" name="active" value="${nextActive}">
      <button class="toggle ${user.active ? "danger" : ""}" type="submit">
        ${user.active ? "Deactivate" : "Activate"}
      </button>
    </form>
  </article>`;
}

export function renderAdminPage(input: {
  users: AdminWhitelistUser[];
  csrfToken: string;
  result?: string | undefined;
  error?: string | undefined;
}): string {
  const users = input.users.length
    ? input.users.map((user) => userCard(user, input.csrfToken)).join("")
    : '<div class="empty">No users are currently whitelisted.</div>';
  const error = input.error
    ? `<div class="notice error" role="alert">${escapeHtml(input.error)}</div>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow, noarchive">
  <title>Whitelist administration</title>
  <link rel="stylesheet" href="/admin.css">
</head>
<body>
  <main class="shell">
    <header class="topbar">
      <div>
        <p class="eyebrow">WhatsApp assistant</p>
        <h1>Whitelist administration</h1>
        <p class="subtitle">Add approved testers, choose exactly what company information they can access, and suspend access without deleting audit history.</p>
      </div>
      <div class="top-actions">
        <div class="secure">Admin connection</div>
        <form method="post" action="/logout">
          <input type="hidden" name="csrf" value="${escapeHtml(input.csrfToken)}">
          <button class="logout" type="submit">Sign out</button>
        </form>
      </div>
    </header>
    ${resultNotice(input.result)}
    ${error}
    <div class="grid">
      <section class="card" aria-labelledby="add-user-title">
        <div class="card-head">
          <h2 id="add-user-title">Add or update a user</h2>
          <p>Submitting an existing phone number updates that user and replaces their permissions.</p>
        </div>
        <form class="form" method="post" action="/users">
          <input type="hidden" name="csrf" value="${escapeHtml(input.csrfToken)}">
          <div class="field">
            <label for="name">Full name</label>
            <input id="name" name="name" type="text" minlength="2" maxlength="120" autocomplete="off" required>
          </div>
          <div class="field">
            <label for="phone">WhatsApp number</label>
            <input id="phone" name="phone" type="tel" placeholder="+90 5xx xxx xx xx" maxlength="30" autocomplete="off" required>
          </div>
          <div class="field">
            <label for="department">Department <span class="hint">(optional)</span></label>
            <input id="department" name="department" type="text" maxlength="100" autocomplete="off">
          </div>
          <div class="field-row">
            <div class="field">
              <label for="role">Role</label>
              <select id="role" name="role">
                <option value="employee" selected>Employee</option>
                <option value="manager">Manager</option>
                <option value="executive">Executive</option>
                <option value="admin">Admin</option>
              </select>
            </div>
            <div class="field">
              <label for="locale">Language</label>
              <select id="locale" name="locale">
                <option value="tr" selected>Turkish</option>
                <option value="en">English</option>
              </select>
            </div>
          </div>
          <fieldset>
            <legend>Company-data permissions</legend>
            <div class="checks">
              <label class="check"><input type="checkbox" name="permissions" value="company.sales"> Sales summaries</label>
              <label class="check"><input type="checkbox" name="permissions" value="company.projects"> Project information</label>
              <label class="check"><input type="checkbox" name="permissions" value="company.tasks"> Task information</label>
              <label class="check"><input type="checkbox" name="permissions" value="company.database.explore"> Approved database explorer</label>
            </div>
            <p class="hint">Database explorer requires the Executive or Admin role. Leave all unchecked for chat-only access.</p>
          </fieldset>
          <button class="primary" type="submit">Save whitelist user</button>
        </form>
      </section>
      <section class="card" aria-labelledby="users-title">
        <div class="card-head">
          <h2 id="users-title">Approved users</h2>
          <p>Phone numbers stay masked in the browser. Changes are written to the tamper-evident audit log.</p>
        </div>
        <div class="users">${users}</div>
      </section>
    </div>
    <p class="footer">Meta test numbers also require the recipient to be verified separately in Meta Developers.</p>
  </main>
</body>
</html>`;
}
