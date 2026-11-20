import type { User } from "./db";
import { scopeDescriptions, type AuthorizationRequest } from "./oauth";

const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );

function layout(title: string, body: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)} · Sanaa Kenya</title><style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f1e8;color:#1d1b16;font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{width:min(420px,calc(100vw - 32px));background:#fff;border:1px solid #e7e2d8;border-radius:16px;padding:28px}
h1{font-size:22px;margin:0 0 8px}p{margin:0 0 14px}.muted{color:#6b665c;font-size:13px}
label{display:block;font-weight:600;margin:12px 0 4px}input{width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #cfc8bb;border-radius:10px;font:inherit}
input:focus-visible,button:focus-visible,a:focus-visible{outline:2px solid #b5532b;outline-offset:2px}
.row{display:flex;gap:10px;margin-top:20px}button{flex:1;border:0;border-radius:999px;padding:11px 16px;font:inherit;font-weight:600;cursor:pointer}
.primary{background:#b5532b;color:#fff}.secondary{background:#efe9df;color:#1d1b16}
ul{padding-left:20px;margin:0 0 14px}.error{background:#fdecea;color:#8c2316;border-radius:10px;padding:10px 12px}
a{color:#9a4422}.brand{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#b5532b;font-weight:700;margin-bottom:10px}
</style></head><body><main><div class="brand">Sanaa Kenya</div>${body}</main></body></html>`;
}

export function signInPage(options: {
  query: string;
  clientName: string;
  error?: string;
}) {
  return layout(
    "Sign in",
    `<h1>Sign in to connect</h1>
<p><strong>${escape(options.clientName)}</strong> wants to connect to your Sanaa Kenya account.</p>
${options.error ? `<p class="error" role="alert">${escape(options.error)}</p>` : ""}
<form method="post" action="/oauth/authorize">
<input type="hidden" name="action" value="login"><input type="hidden" name="query" value="${escape(options.query)}">
<label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email" required maxlength="254">
<label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required minlength="12" maxlength="128">
<div class="row"><button class="primary" type="submit">Sign in</button></div>
</form>
<p class="muted" style="margin-top:16px">Use Google or need an account? <a href="/" target="_blank" rel="noopener">Open Sanaa Kenya</a>, sign in there, then reload this page.</p>`,
  );
}

export function consentPage(options: {
  requestId: string;
  request: AuthorizationRequest;
  user: User;
}) {
  const { request, user } = options;
  const host = new URL(request.redirectUri).host;
  return layout(
    "Allow access",
    `<h1>Allow ${escape(request.clientName)}?</h1>
<p>It will be able to:</p>
<ul>${request.scopes.map((scope) => `<li>${escape(scopeDescriptions[scope])}</li>`).join("")}</ul>
<p class="muted">Signed in as ${escape(user.name)} (${escape(user.email)}). You will return to <strong>${escape(host)}</strong>. Nothing is booked or charged through this connection.</p>
<form method="post" action="/oauth/authorize">
<input type="hidden" name="action" value="consent"><input type="hidden" name="request_id" value="${escape(options.requestId)}">
<div class="row"><button class="secondary" type="submit" name="decision" value="deny">Cancel</button><button class="primary" type="submit" name="decision" value="allow">Allow</button></div>
</form>`,
  );
}

export function errorPage(message: string) {
  return layout(
    "Cannot connect",
    `<h1>Cannot connect</h1><p class="error" role="alert">${escape(message)}</p><p class="muted">Return to the app that sent you here and try connecting again.</p>`,
  );
}
