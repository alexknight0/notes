// Notes AI summaries (Worker "notes-ai", wrangler-ai.toml): POST /summary {text} -> {summary}.
// The Projects view shows the summary instead of a task's text when the text is longer than
// three lines on screen; app.js stores it on the task (summary, summaryOf) so each text is only
// summarised once.
//
// Who may use it: anyone Firestore lets read their own users/{uid} doc. The site sends its Firebase
// ID token; we forward it to the Firestore REST API, so firestore.rules (Alex + config/access)
// stay the one access list. A token that passed is remembered until it expires.
//
// Runs on Workers AI's free allocation (10,000 neurons/day, Workers Free plan, so it can't be
// billed: past the allocation requests just fail until 00:00 UTC). One summary of a ~200-word
// note costs ~3 neurons.

const PROJECT = "notes-e2b6c3";
const FIRESTORE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const MODEL = "@cf/google/gemma-4-26b-a4b-it";
const MAX_TEXT = 20_000; // characters; longer notes are cut before summarising
const ORIGINS = ["https://alexknight0.github.io", "http://localhost:8766", "http://localhost:8767"];
const PROMPT = `You write the preview line for a long note in someone's to-do app.
Summarise the note in at most 25 words, as terse note-style text in the note's own voice and language.
Keep what matters for deciding what to do: actions, deadlines, names, numbers.
Plain text only: no preamble, no quotes, no markdown, no "This note…".`;

const allowed = new Map(); // ID token -> expiry (ms)

function cors(request) {
  const origin = request.headers.get("Origin");
  return {
    "Access-Control-Allow-Origin": ORIGINS.includes(origin) ? origin : ORIGINS[0],
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}
const reply = (request, body, status = 200) => Response.json(body, { status, headers: cors(request) });

// The token's claims (unverified: Firestore checks the signature when we use it).
function claims(token) {
  try {
    const part = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(part));
  } catch {
    return null;
  }
}

async function signedIn(token) {
  const exp = allowed.get(token);
  if (exp && exp > Date.now()) return true;
  const uid = claims(token)?.user_id;
  if (!uid || !/^[\w-]{1,128}$/.test(uid)) return false;
  const res = await fetch(`${FIRESTORE}/users/${uid}?mask.fieldPaths=thoughtsReviewedAt`, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status !== 200 && res.status !== 404) return false; // 404: allowed, the doc just doesn't exist yet
  for (const [t, e] of allowed) if (e < Date.now()) allowed.delete(t);
  allowed.set(token, (claims(token).exp ?? 0) * 1000);
  return true;
}

async function summarise(env, text) {
  const out = await env.AI.run(MODEL, {
    messages: [{ role: "system", content: PROMPT }, { role: "user", content: text.slice(0, MAX_TEXT) }],
    max_tokens: 120,
    temperature: 0.2,
    chat_template_kwargs: { enable_thinking: false }, // Gemma 4 otherwise spends the tokens reasoning
  });
  const raw = out?.choices?.[0]?.message?.content ?? out?.response ?? "";
  return raw.trim().replace(/^["“]|["”]$/g, "").trim();
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(request) });
    if (url.pathname !== "/summary" || request.method !== "POST") return reply(request, { error: "not found" }, 404);
    const token = request.headers.get("Authorization")?.replace(/^Bearer /, "");
    if (!token || !(await signedIn(token))) return reply(request, { error: "not signed in" }, 401);
    let body;
    try {
      body = await request.json();
    } catch {
      return reply(request, { error: "bad JSON" }, 400);
    }
    if (typeof body?.text !== "string" || !body.text.trim()) return reply(request, { error: "no text" }, 400);
    try {
      const summary = await summarise(env, body.text);
      if (!summary) return reply(request, { error: "empty summary" }, 502);
      return reply(request, { summary });
    } catch (err) {
      console.error("summary failed", err);
      return reply(request, { error: String(err?.message ?? err) }, 502);
    }
  },
};
