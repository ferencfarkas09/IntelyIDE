#!/usr/bin/env node
// Creates, in YOUR Brevo account, what the newsletter needs: a contact list for IntelyIDE and a double opt-in template (the mail with the
// confirmation link). Run it once, by hand. It reuses a list and a template that already carry these names, so a second run changes nothing.
// It never touches any other list or template of the account.
//
//   BREVO_API_KEY=... node scripts/brevo-setup.mjs --sender-email news@example.com --sender-name "IntelyIDE" [--folder-id 1] [--dry-run]
//
// --sender-email must be a sender you verified in Brevo (Senders, domains and dedicated IPs). A mail from your own domain with SPF and DKIM
// set up arrives; one from a free mail address often does not.
// It prints the two numbers to put into wrangler.jsonc (BREVO_LIST_ID, BREVO_DOI_TEMPLATE_ID). The API key is only read from the environment and never printed.

import { parseArgs } from "node:util";

const API = "https://api.brevo.com/v3";
const LIST_NAME = "IntelyIDE users";
const TEMPLATE_NAME = "IntelyIDE newsletter: confirm your address";

const { values } = parseArgs({
  options: {
    "sender-email": { type: "string" },
    "sender-name": { type: "string", default: "IntelyIDE" },
    "folder-id": { type: "string", default: "1" },
    "privacy-url": { type: "string", default: "https://intelyhome.com/" },
    "dry-run": { type: "boolean", default: false },
  },
});

const key = process.env.BREVO_API_KEY ?? "";
if (!values["dry-run"] && !key) fail("BREVO_API_KEY is not set (Brevo > SMTP & API > API keys).");
if (!values["sender-email"]) fail("--sender-email is required (a sender you verified in Brevo).");
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values["sender-email"])) fail("--sender-email is not an email address.");
if (!/^\d+$/.test(values["folder-id"])) fail("--folder-id must be a number.");

function fail(message) {
  console.error(`brevo-setup: ${message}`);
  process.exit(1);
}

async function call(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    redirect: "error",
    headers: { "api-key": key, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  if (!res.ok) fail(`${method} ${path} answered ${res.status}: ${json?.message ?? text.slice(0, 200)}`);
  return json;
}

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// Brevo puts the confirmation link where {{ params.DOUBLEOPTIN }} stands.
const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Confirm your address</title></head>
<body style="margin:0;padding:24px;background:#f5f5f4;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1c1917">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:8px;padding:28px">
<tr><td style="font-size:15px;line-height:1.55">
<p style="margin:0 0 14px">Hi {{ contact.FIRSTNAME }},</p>
<p style="margin:0 0 14px">you asked for the IntelyIDE newsletter in the app. Please confirm your address, then we send you news about new versions and features. If it was not you, ignore this mail: nothing is sent without your click.</p>
<p style="margin:22px 0"><a href="{{ params.DOUBLEOPTIN }}" style="background:#2563eb;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:6px;display:inline-block">Confirm my address</a></p>
<hr style="border:none;border-top:1px solid #e7e5e4;margin:22px 0">
<p style="margin:0 0 14px">Szia {{ contact.FIRSTNAME }},</p>
<p style="margin:0 0 14px">az alkalmazásban kérted az IntelyIDE hírlevelét. Kérjük, erősítsd meg a címedet, utána küldjük az új verziókról és funkciókról szóló híreket. Ha nem te voltál, hagyd figyelmen kívül ezt a levelet: a kattintásod nélkül semmi sem megy ki.</p>
<p style="margin:22px 0"><a href="{{ params.DOUBLEOPTIN }}" style="background:#2563eb;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:6px;display:inline-block">Megerősítem a címemet</a></p>
<p style="margin:22px 0 0;font-size:12px;color:#78716c">What we store and how to have it deleted / Mit tárolunk és hogyan töröltethető: <a href="${esc(values["privacy-url"])}" style="color:#78716c">${esc(values["privacy-url"])}</a></p>
</td></tr></table></td></tr></table></body></html>`;

const template = {
  templateName: TEMPLATE_NAME,
  subject: "Confirm your IntelyIDE newsletter / Erősítsd meg az IntelyIDE hírlevelet",
  sender: { name: values["sender-name"], email: values["sender-email"] },
  htmlContent: html,
  isActive: true,
};

if (values["dry-run"]) {
  console.log(`would create the list "${LIST_NAME}" in folder ${values["folder-id"]} (or reuse it), and the template "${TEMPLATE_NAME}" (or reuse it):`);
  console.log(JSON.stringify({ ...template, htmlContent: `<${html.length} characters>` }, null, 2));
  process.exit(0);
}

const lists = await call("GET", "/contacts/lists?limit=50&offset=0");
let list = (lists?.lists ?? []).find((l) => l.name === LIST_NAME);
if (list) console.log(`list "${LIST_NAME}" exists: ${list.id}`);
else {
  list = await call("POST", "/contacts/lists", { name: LIST_NAME, folderId: Number(values["folder-id"]) });
  console.log(`list "${LIST_NAME}" created: ${list.id}`);
}

const templates = await call("GET", "/smtp/templates?limit=100&offset=0&templateStatus=true");
let tpl = (templates?.templates ?? []).find((t) => t.name === TEMPLATE_NAME);
if (tpl) console.log(`template "${TEMPLATE_NAME}" exists: ${tpl.id}`);
else {
  tpl = await call("POST", "/smtp/templates", template);
  console.log(`template "${TEMPLATE_NAME}" created: ${tpl.id}`);
}

console.log(`
Put these in registry/wrangler.jsonc ("vars") and set the provider on:
  "NEWSLETTER_PROVIDER": "brevo",
  "BREVO_LIST_ID": "${list.id}",
  "BREVO_DOI_TEMPLATE_ID": "${tpl.id}"
Then store the key as a secret (it is not printed here):  pnpm exec wrangler secret put BREVO_API_KEY
Send yourself a test: register in the app (or with curl) with the newsletter box ticked and check that the mail arrives and the link adds you to "${LIST_NAME}".`);
