// Notes app: Google sign-in (Firebase Auth) + Firestore.
// Data (all restricted to the owner by firestore.rules):
//   users/{uid}             { scratch, scratchUpdatedAt, thoughtsReviewedAt }
//   users/{uid}/notes/{id}  { type: "urgent"|"fact"|"thought", text, createdAt, updatedAt,
//                             due?, done?          (urgent)
//                             image?, embedding?   (fact; image is a JPEG data URL)
//                             archived?, reviewedAt? (thought) }
//   notes/{uid}             { text }  — the original single note, migrated into scratch once.
import { initializeApp } from "https://www.gstatic.com/firebasejs/13.0.0/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut,
} from "https://www.gstatic.com/firebasejs/13.0.0/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, onSnapshot, setDoc, addDoc, updateDoc, deleteDoc, getDoc,
  serverTimestamp, Timestamp,
} from "https://www.gstatic.com/firebasejs/13.0.0/firebase-firestore.js";
import * as chrono from "https://esm.sh/chrono-node@2.10.3";
import { loadModel, embed, rank } from "./search.js";

// Public web-app config (not a secret; access is controlled by firestore.rules).
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyBf8KKXDVMi-iIbRfI64NgUtK1kM0QdmSw",
  authDomain: "notes-e2b6c3.firebaseapp.com",
  projectId: "notes-e2b6c3",
  appId: "1:901046426288:web:a4206278ac235fcb74b975",
};

const SAVE_DELAY_MS = 800;
const DEFAULT_DUE_HOUR = 9; // used when a typed date has no time, e.g. "pay rent friday"
const IMAGE_MAX_SIDE = 1024;
const IMAGE_MAX_CHARS = 200_000; // data URL length; Firestore docs are capped at 1 MiB

const app = initializeApp(FIREBASE_CONFIG);
const auth = getAuth(app);
// Persistent cache: the app opens instantly from the last-seen data and works offline.
const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
});

const $ = (id) => document.getElementById(id);

let userRef = null;
let notesCol = null;
let unsubs = [];
let notes = []; // [{id, ...data}]
let userData = {};

// ---------- helpers ----------

function setStatus(text, isError = false) {
  $("status").textContent = text;
  $("status").classList.toggle("error", isError);
}

async function guard(promise, what) {
  try {
    return await promise;
  } catch (err) {
    setStatus(`Couldn't ${what}: ${err.message}`, true);
    throw err;
  }
}

const toDate = (ts) => (ts instanceof Timestamp ? ts.toDate() : ts ? new Date(ts) : null);

// <input type="datetime-local"> value <-> Date (local time)
function toLocalInput(date) {
  if (!date) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
const fromLocalInput = (value) => (value ? new Date(value) : null);

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
function relative(date) {
  const mins = Math.round((date - Date.now()) / 60000);
  const abs = Math.abs(mins);
  if (abs < 60) return rtf.format(mins, "minute");
  if (abs < 48 * 60) return rtf.format(Math.round(mins / 60), "hour");
  return rtf.format(Math.round(mins / 1440), "day");
}
function formatDate(date) {
  const opts = { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" };
  if (date.getFullYear() !== new Date().getFullYear()) opts.year = "numeric";
  return date.toLocaleString(undefined, opts);
}

// Finds a date in free text ("dentist fri 3pm"). Returns {date, text-without-date} or null.
function parseDue(text) {
  const [result] = chrono.parse(text, new Date(), { forwardDate: true });
  if (!result) return null;
  const date = result.start.date();
  if (!result.start.isCertain("hour")) date.setHours(DEFAULT_DUE_HOUR, 0, 0, 0);
  const rest = (text.slice(0, result.index) + text.slice(result.index + result.text.length))
    .replace(/\s+(on|at|by|due)\s*$/i, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return { date, text: rest || text.trim() };
}

// Downscale and JPEG-compress a photo so it fits comfortably inside a Firestore document.
async function compressImage(file) {
  const bitmap = await createImageBitmap(file);
  let side = IMAGE_MAX_SIDE;
  for (;;) {
    const scale = Math.min(1, side / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.8, 0.65, 0.5]) {
      const url = canvas.toDataURL("image/jpeg", quality);
      if (url.length <= IMAGE_MAX_CHARS) return url;
    }
    side = Math.round(side * 0.75);
  }
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node[k] = v;
  }
  node.append(...children.filter((c) => c != null));
  return node;
}

// ---------- views / routing ----------

const VIEWS = ["scratch", "urgent", "facts", "thoughts"];

function route() {
  const view = VIEWS.includes(location.hash.slice(1)) ? location.hash.slice(1) : "scratch";
  for (const v of VIEWS) $(`view-${v}`).hidden = v !== view;
  for (const a of document.querySelectorAll("#tabs a")) a.classList.toggle("active", a.dataset.view === view);
  $("view-title").textContent = $(`view-${view}`).dataset.title;
  if (view === "facts") startSemanticSearch();
}
window.addEventListener("hashchange", route);

// ---------- scratch pad ----------

const scratch = $("scratch");
let scratchTimer = null;

async function saveScratch() {
  clearTimeout(scratchTimer);
  scratchTimer = null;
  if (!userRef) return;
  await guard(setDoc(userRef, { scratch: scratch.value, scratchUpdatedAt: serverTimestamp() }, { merge: true }), "save");
  setStatus("Saved");
}

scratch.addEventListener("input", () => {
  setStatus("Editing…");
  clearTimeout(scratchTimer);
  scratchTimer = setTimeout(saveScratch, SAVE_DELAY_MS);
});

// ---------- rendering ----------

function noteItem(note, { leading, actions = [], meta, extraClass = "" } = {}) {
  const body = el("div", { class: "body", onclick: () => openEditor(note) },
    el("div", { class: "text", textContent: note.text }),
    meta ? el("div", { class: "meta", textContent: meta }) : null);
  const thumb = note.image
    ? el("img", { class: "thumb", src: note.image, alt: "", onclick: () => openEditor(note) })
    : null;
  return el("li", { class: extraClass }, leading, thumb, body,
    actions.length ? el("div", { class: "actions" }, ...actions) : null);
}

function fillList(list, items, emptyText) {
  list.replaceChildren(...(items.length ? items : [el("li", { class: "empty", textContent: emptyText })]));
}

function renderUrgent() {
  const urgent = notes.filter((n) => n.type === "urgent");
  const open = urgent.filter((n) => !n.done)
    .sort((a, b) => (toDate(a.due)?.getTime() ?? Infinity) - (toDate(b.due)?.getTime() ?? Infinity));
  const done = urgent.filter((n) => n.done).sort((a, b) => toDate(b.updatedAt) - toDate(a.updatedAt));
  const now = Date.now();

  const item = (n) => {
    const due = toDate(n.due);
    const check = el("input", {
      type: "checkbox", checked: Boolean(n.done), ariaLabel: "Done",
      onchange: (e) => guard(updateDoc(doc(notesCol, n.id), { done: e.target.checked, updatedAt: serverTimestamp() }), "update"),
    });
    return noteItem(n, {
      leading: check,
      meta: due ? `${formatDate(due)} · ${relative(due)}` : "No deadline",
      extraClass: n.done ? "done" : due && due < now ? "overdue" : "",
    });
  };
  fillList($("urgent-list"), open.map(item), "Nothing urgent 🎉");
  $("urgent-done").replaceChildren(...done.map(item));
  $("urgent-done-count").textContent = done.length;
  $("urgent-done-wrap").hidden = !done.length;

  const overdue = open.filter((n) => n.due && toDate(n.due) < now).length;
  $("urgent-badge").textContent = overdue;
  $("urgent-badge").hidden = !overdue;
}

let factQueryEmbedding = null;
let factQuery = "";

function renderFacts() {
  const facts = notes.filter((n) => n.type === "fact");
  const shown = factQuery
    ? rank(facts, factQuery, factQueryEmbedding)
    : facts.sort((a, b) => toDate(b.createdAt) - toDate(a.createdAt));
  fillList($("fact-list"), shown.map((n) => noteItem(n, {
    meta: toDate(n.createdAt)?.toLocaleDateString(),
  })), factQuery ? "No matching facts" : "No facts yet");
}

function thoughtsCutoff() {
  return toDate(userData.thoughtsReviewedAt)?.getTime() ?? 0;
}

function renderThoughts() {
  const thoughts = notes.filter((n) => n.type === "thought")
    .sort((a, b) => toDate(b.createdAt) - toDate(a.createdAt));
  const cutoff = thoughtsCutoff();
  const live = thoughts.filter((n) => !n.archived);
  const fresh = live.filter((n) => toDate(n.createdAt) > cutoff);
  const older = live.filter((n) => toDate(n.createdAt) <= cutoff);
  const archived = thoughts.filter((n) => n.archived);

  const convert = (n, type, label) => el("button", {
    type: "button", class: "small", textContent: label,
    onclick: () => guard(updateDoc(doc(notesCol, n.id), { type, updatedAt: serverTimestamp() }), "move"),
  });
  const item = (n) => noteItem(n, {
    meta: toDate(n.createdAt)?.toLocaleDateString(),
    actions: [
      convert(n, "urgent", "→ Urgent"),
      convert(n, "fact", "→ Fact"),
      el("button", {
        type: "button", class: "small", textContent: n.archived ? "Unarchive" : "Archive",
        onclick: () => guard(updateDoc(doc(notesCol, n.id), { archived: !n.archived, updatedAt: serverTimestamp() }), "archive"),
      }),
    ],
  });
  fillList($("thought-new"), fresh.map(item), "Nothing new since your last review");
  fillList($("thought-old"), older.map(item), "Nothing here");
  $("thought-archived").replaceChildren(...archived.map(item));
  $("thought-archived-count").textContent = archived.length;
  $("thought-archived-wrap").hidden = !archived.length;
  $("thoughts-reviewed").hidden = !fresh.length;
  $("thought-badge").textContent = fresh.length;
  $("thought-badge").hidden = !fresh.length;
}

function renderAll() {
  renderUrgent();
  renderFacts();
  renderThoughts();
}
// Keep "in 2 hours" / overdue state fresh.
setInterval(renderUrgent, 60_000);

// ---------- capture forms ----------

// Urgent: typing a date fills the due field until the user edits it by hand.
let dueTouched = false;
$("urgent-text").addEventListener("input", () => {
  if (dueTouched) return;
  $("urgent-due").value = toLocalInput(parseDue($("urgent-text").value)?.date);
});
$("urgent-due").addEventListener("input", () => { dueTouched = true; });

$("urgent-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const raw = $("urgent-text").value.trim();
  if (!raw) return;
  const parsed = parseDue(raw);
  const due = fromLocalInput($("urgent-due").value);
  // Only strip the date words when the due time still comes from them.
  const text = parsed && !dueTouched ? parsed.text : raw;
  $("urgent-form").reset();
  dueTouched = false;
  await guard(addDoc(notesCol, {
    type: "urgent", text, due: due ? Timestamp.fromDate(due) : null, done: false,
    createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
  }), "add");
});

let pendingFactImage = null;
$("fact-image").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  pendingFactImage = await compressImage(file);
  $("fact-image-preview").src = pendingFactImage;
  $("fact-image-preview").hidden = false;
  $("fact-image-clear").hidden = false;
});
function clearFactImage() {
  pendingFactImage = null;
  $("fact-image").value = "";
  $("fact-image-preview").hidden = true;
  $("fact-image-clear").hidden = true;
}
$("fact-image-clear").addEventListener("click", clearFactImage);

$("fact-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = $("fact-text").value.trim();
  if (!text && !pendingFactImage) return;
  const image = pendingFactImage;
  $("fact-text").value = "";
  clearFactImage();
  await guard(addDoc(notesCol, {
    type: "fact", text, image, embedding: null,
    createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
  }), "add");
  backfillEmbeddings();
});

$("thought-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = $("thought-text").value.trim();
  if (!text) return;
  $("thought-text").value = "";
  await guard(addDoc(notesCol, {
    type: "thought", text, archived: false,
    createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
  }), "add");
});

$("thoughts-reviewed").addEventListener("click", () =>
  guard(setDoc(userRef, { thoughtsReviewedAt: serverTimestamp() }, { merge: true }), "save"));

// Ctrl/Cmd+Enter submits the multi-line capture boxes.
for (const id of ["fact-text", "thought-text"]) {
  $(id).addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) e.target.form.requestSubmit();
  });
}

// ---------- semantic search ----------

let semanticState = "off"; // off | loading | ready | failed

function startSemanticSearch() {
  if (semanticState !== "off") return;
  semanticState = "loading";
  $("search-status").textContent = "Loading smart search…";
  loadModel((pct) => { $("search-status").textContent = `Loading smart search… ${pct}%`; })
    .then(async () => {
      semanticState = "ready";
      $("search-status").textContent = "";
      await backfillEmbeddings();
      if (factQuery) await runFactSearch();
    })
    .catch((err) => {
      semanticState = "failed";
      $("search-status").textContent = `Smart search unavailable (${err.message}); using keyword search.`;
    });
}

// Compute embeddings for facts that don't have one yet (new or edited).
let backfilling = false;
async function backfillEmbeddings() {
  if (semanticState !== "ready" || backfilling) return;
  backfilling = true;
  try {
    for (const n of notes.filter((x) => x.type === "fact" && !x.embedding && x.text)) {
      const embedding = await embed(n.text);
      await updateDoc(doc(notesCol, n.id), { embedding });
    }
  } catch (err) {
    console.warn("Embedding backfill failed", err);
  } finally {
    backfilling = false;
  }
}

let searchSeq = 0;
async function runFactSearch() {
  const seq = ++searchSeq;
  factQuery = $("fact-search").value.trim();
  factQueryEmbedding = null;
  renderFacts(); // keyword results straight away
  if (factQuery && semanticState === "ready") {
    const e = await embed(factQuery);
    if (seq !== searchSeq) return; // a newer query superseded this one
    factQueryEmbedding = e;
    renderFacts();
  }
}
$("fact-search").addEventListener("input", runFactSearch);

// ---------- edit dialog ----------

const dialog = $("edit");
let editing = null; // {note, image}

function openEditor(note) {
  editing = { note, image: note.image ?? null };
  dialog.returnValue = "";
  $("edit-type").value = note.type;
  $("edit-text").value = note.text;
  $("edit-due").value = toLocalInput(toDate(note.due));
  syncEditorFields();
  dialog.showModal();
}

function syncEditorFields() {
  const type = $("edit-type").value;
  $("edit-due-wrap").hidden = type !== "urgent";
  $("edit-image-wrap").hidden = type !== "fact" && !editing.image;
  $("edit-image").hidden = !editing.image;
  $("edit-image-remove").hidden = !editing.image;
  if (editing.image) $("edit-image").src = editing.image;
}
$("edit-type").addEventListener("change", syncEditorFields);

$("edit-image-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  editing.image = await compressImage(file);
  e.target.value = "";
  syncEditorFields();
});
$("edit-image-remove").addEventListener("click", () => { editing.image = null; syncEditorFields(); });

$("edit-delete").addEventListener("click", async () => {
  if (!confirm("Delete this note?")) return;
  const { note } = editing;
  dialog.close();
  await guard(deleteDoc(doc(notesCol, note.id)), "delete");
});

dialog.addEventListener("close", async () => {
  if (dialog.returnValue !== "save" || !editing) return;
  const { note, image } = editing;
  const type = $("edit-type").value;
  const text = $("edit-text").value.trim();
  const due = fromLocalInput($("edit-due").value);
  const changes = { type, text, image, updatedAt: serverTimestamp() };
  if (type === "urgent") {
    changes.due = due ? Timestamp.fromDate(due) : null;
    changes.done = note.type === "urgent" ? Boolean(note.done) : false;
  }
  if (type === "thought" && note.type !== "thought") changes.archived = false;
  if (text !== note.text || type !== note.type) changes.embedding = null; // recomputed by backfill
  dialog.returnValue = "";
  await guard(updateDoc(doc(notesCol, note.id), changes), "save");
  backfillEmbeddings();
});

// ---------- auth & live data ----------

// One-time copy of the original single note into the scratch pad.
async function migrateOldNote(user) {
  if (userData.scratch !== undefined) return;
  const old = await getDoc(doc(db, "notes", user.uid)).catch(() => null);
  const text = old?.data()?.text;
  if (text) await setDoc(userRef, { scratch: text, scratchUpdatedAt: serverTimestamp() }, { merge: true });
}

onAuthStateChanged(auth, (user) => {
  unsubs.forEach((u) => u());
  unsubs = [];
  notes = [];
  userData = {};

  $("signin").hidden = Boolean(user);
  $("signout").hidden = !user;
  $("signed-out-msg").hidden = Boolean(user);
  $("app").hidden = !user;
  $("tabs").hidden = !user;
  $("user-email").textContent = user ? user.email : "";

  if (!user) {
    userRef = notesCol = null;
    scratch.value = "";
    setStatus("");
    return;
  }

  userRef = doc(db, "users", user.uid);
  notesCol = collection(userRef, "notes");
  setStatus("Loading…");
  let migrated = false;

  unsubs.push(onSnapshot(userRef, (snap) => {
    userData = snap.data({ serverTimestamps: "estimate" }) ?? {};
    // Don't clobber what the user is typing; local pending writes are our own.
    if (!scratchTimer && !snap.metadata.hasPendingWrites) scratch.value = userData.scratch ?? "";
    renderThoughts();
    setStatus(snap.metadata.fromCache ? "Offline — changes will sync later" : "Saved");
    if (!migrated && !snap.metadata.fromCache) {
      migrated = true;
      migrateOldNote(user);
    }
  }, (err) => setStatus(`Couldn't load: ${err.message}`, true)));

  unsubs.push(onSnapshot(notesCol, (snap) => {
    notes = snap.docs.map((d) => ({ id: d.id, ...d.data({ serverTimestamps: "estimate" }) }));
    renderAll();
    backfillEmbeddings();
  }, (err) => setStatus(`Couldn't load notes: ${err.message}`, true)));
});

$("signin").addEventListener("click", async () => {
  try {
    await signInWithPopup(auth, new GoogleAuthProvider());
  } catch (err) {
    if (err.code !== "auth/popup-closed-by-user" && err.code !== "auth/cancelled-popup-request") {
      setStatus(`Couldn't sign in: ${err.message}`, true);
    }
  }
});

$("signout").addEventListener("click", async () => {
  if (scratchTimer) await saveScratch();
  signOut(auth);
});

// Save the scratch pad straight away if the app is hidden/closed with unsaved edits.
document.addEventListener("visibilitychange", () => { if (document.hidden && scratchTimer) saveScratch(); });

route();
// Opened from a home-screen shortcut (e.g. ./#urgent): jump straight into the capture box.
if (location.hash) {
  const target = { urgent: "urgent-text", facts: "fact-text", thoughts: "thought-text", scratch: "scratch" }[location.hash.slice(1)];
  if (target) setTimeout(() => $(target).focus(), 300);
}
