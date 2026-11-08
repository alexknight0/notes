// Notes task reminders: a Cloudflare Worker cron (every minute, wrangler.toml) that sends a push
// notification when a task comes due. Replaced the GitHub Actions cron on 2026-11-08: GitHub
// didn't start a single scheduled run in the first 40 minutes.
//
// For every user with a registered device (users/{uid}/devices/{id} = {token, timeZone}), each
// open task whose due time has passed (within the last MAX_LATE_MS) and hasn't been reminded
// about gets one notification per device through the FCM HTTP v1 API, then remindedDue = due so
// it isn't sent again (changing the due date re-arms it). sw.js on the site shows the push.
//
// Signs in to Google as reminders@notes-e2b6c3 with its key (secret SA_KEY = the JSON key file).
// That account can only use Firestore and send FCM messages.

const PROJECT = "notes-e2b6c3";
const DOCS = `projects/${PROJECT}/databases/(default)/documents`;
const FIRESTORE = "https://firestore.googleapis.com/v1";
const FCM = `https://fcm.googleapis.com/v1/projects/${PROJECT}/messages:send`;
// Tasks overdue by more than this are skipped (e.g. when reminders are first turned on, or the
// cron stopped for a while), so nobody gets a pile of stale notifications at once.
const MAX_LATE_MS = 12 * 3600_000;
const EARLY_MS = 30_000; // the cron fires at the start of each minute, just after a :00 due time
const TTL_SECONDS = 6 * 3600; // a push the phone can't receive within this long is dropped

// ---------- Google sign-in (service-account JWT -> access token) ----------

let cachedToken = null; // {token, exp}; isolates are reused, so this saves a sign-in most minutes

const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlText = (text) => b64url(new TextEncoder().encode(text));

async function accessToken(env) {
  if (cachedToken && cachedToken.exp > Date.now() + 60_000) return cachedToken.token;
  const key = JSON.parse(env.SA_KEY);
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: key.client_email, scope: "https://www.googleapis.com/auth/cloud-platform",
    aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600,
  };
  const unsigned = `${b64urlText(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64urlText(JSON.stringify(claims))}`;
  const pem = key.private_key.replace(/-----[^-]+-----|\s/g, "");
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const signer = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", signer, new TextEncoder().encode(unsigned));
  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${b64url(sig)}` }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(`Google sign-in failed (${resp.status}): ${JSON.stringify(data)}`);
  cachedToken = { token: data.access_token, exp: Date.now() + data.expires_in * 1000 };
  return cachedToken.token;
}

async function call(token, method, url, body) {
  const resp = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await resp.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  return { status: resp.status, data };
}

// ---------- Firestore ----------

function value(field) {
  if (!field) return null;
  if ("stringValue" in field) return field.stringValue;
  if ("booleanValue" in field) return field.booleanValue;
  if ("timestampValue" in field) return Date.parse(field.timestampValue);
  return null;
}

async function runQuery(token, parent, structuredQuery) {
  const { status, data } = await call(token, "POST", `${FIRESTORE}/${parent}:runQuery`, { structuredQuery });
  if (status !== 200) throw new Error(`query failed (${status}): ${JSON.stringify(data)}`);
  return data.filter((r) => r.document).map((r) => r.document);
}

async function devicesByUser(token) {
  const docs = await runQuery(token, DOCS, { from: [{ collectionId: "devices", allDescendants: true }] });
  const users = new Map();
  for (const d of docs) {
    const f = d.fields ?? {};
    const deviceToken = value(f.token);
    if (!deviceToken) continue;
    const userPath = d.name.split("/devices/")[0]; // projects/.../documents/users/{uid}
    if (!users.has(userPath)) users.set(userPath, []);
    users.get(userPath).push({ name: d.name, token: deviceToken, timeZone: value(f.timeZone) });
  }
  return users;
}

async function dueTasks(token, userPath, now) {
  const docs = await runQuery(token, userPath, {
    from: [{ collectionId: "notes" }],
    where: { fieldFilter: { field: { fieldPath: "type" }, op: "EQUAL", value: { stringValue: "task" } } },
    select: { fields: ["text", "due", "done", "remindedDue"].map((fieldPath) => ({ fieldPath })) },
  });
  return docs.flatMap((d) => {
    const f = d.fields ?? {};
    const due = value(f.due);
    if (!due || value(f.done)) return [];
    if (!(now - MAX_LATE_MS < due && due <= now + EARLY_MS)) return [];
    if (value(f.remindedDue) === due) return [];
    return [{ name: d.name, id: d.name.split("/").pop(), text: value(f.text) || "Task", due, dueRaw: f.due.timestampValue }];
  });
}

// ---------- the message ----------

export function describe(task, timeZone, now) {
  let tz = "UTC";
  try { if (timeZone) { new Intl.DateTimeFormat("en-AU", { timeZone }); tz = timeZone; } } catch { /* unknown zone */ }
  const time = new Intl.DateTimeFormat("en-AU", { timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true })
    .format(task.due).replace(/\s/g, " ").toLowerCase();
  const day = (t) => new Intl.DateTimeFormat("en-AU", { timeZone: tz, dateStyle: "short" }).format(t);
  let when = time;
  if (day(task.due) !== day(now)) {
    when = `${new Intl.DateTimeFormat("en-AU", { timeZone: tz, weekday: "short", day: "numeric", month: "short" }).format(task.due)}, ${time}`;
  }
  let body = `Due ${when}`;
  const lateMin = Math.floor((now - task.due) / 60_000);
  if (lateMin > 15) {
    const h = Math.floor(lateMin / 60);
    body += ` (${h ? `${h} h ` : ""}${lateMin % 60} min ago)`;
  }
  const title = task.text.trim().split("\n")[0].slice(0, 120);
  return { title, body };
}

async function send(token, device, task, now) {
  const { title, body } = describe(task, device.timeZone, now);
  const { status, data } = await call(token, "POST", FCM, {
    message: {
      token: device.token,
      // Data only: sw.js shows it, so it looks the same whether or not the app is open.
      // FCM data values must be strings.
      data: { title, body, tag: task.id, url: "./#tasks" },
      webpush: { headers: { Urgency: "high", TTL: String(TTL_SECONDS) } },
    },
  });
  if (status === 200) return "ok";
  const codes = (data.error?.details ?? []).map((d) => d.errorCode);
  console.log(`FCM ${status} for device ${device.name.split("/").pop()}: ${JSON.stringify(data.error)}`);
  // The browser unsubscribed (or the token was replaced): forget the device.
  if (status === 404 || codes.includes("UNREGISTERED")) return "gone";
  return "error";
}

export async function runReminders(env, now = Date.now()) {
  const token = await accessToken(env);
  const users = await devicesByUser(token);
  const log = [`${users.size} user(s) with reminders on`];
  for (const [userPath, devices] of users) {
    const tasks = await dueTasks(token, userPath, now);
    if (!tasks.length) continue;
    log.push(`${userPath.split("/").pop()}: ${tasks.length} task(s) to remind, ${devices.length} device(s)`);
    const gone = new Set();
    for (const task of tasks) {
      const results = [];
      for (const device of devices) {
        if (gone.has(device.name)) continue;
        const result = await send(token, device, task, now);
        results.push(result);
        if (result === "gone") gone.add(device.name);
      }
      if (results.includes("error")) continue; // try again next minute
      const { status, data } = await call(token, "PATCH",
        `${FIRESTORE}/${task.name}?updateMask.fieldPaths=remindedDue&currentDocument.exists=true`,
        { fields: { remindedDue: { timestampValue: task.dueRaw } } });
      if (status !== 200) log.push(`couldn't mark ${task.id} reminded (${status}): ${JSON.stringify(data)}`);
    }
    for (const name of gone) {
      log.push(`removing unsubscribed device ${name.split("/").pop()}`);
      await call(token, "DELETE", `${FIRESTORE}/${name}`);
    }
  }
  console.log(log.join("\n"));
  return log;
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runReminders(env));
  },
  // No public use; workers_dev is off. Only reachable under `wrangler dev` for tests.
  async fetch() {
    return new Response("Not found", { status: 404 });
  },
};
