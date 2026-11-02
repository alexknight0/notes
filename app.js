// Notes app: Google sign-in (Firebase Auth) + Firestore.
// Data (all restricted to the owner by firestore.rules):
//   users/{uid}             { scratch, scratchUpdatedAt, thoughtsReviewedAt }
//   users/{uid}/notes/{id}  { type: "task"|"idea"|"thought"|"fact", text, createdAt, updatedAt,
//                             due?, done?          (task; stored as "urgent" before 2026-11-03,
//                                                   migrated on load by migrateUrgentToTask)
//                             image?, embedding?   (fact; image is a JPEG data URL)
//                             archived?            (idea, thought)
//                             tags?                (idea; array of strings) }
//   notes/{uid}             { text }  — the original single note, migrated into scratch once.
import { initializeApp } from "https://www.gstatic.com/firebasejs/13.0.0/firebase-app.js";
import {
  initializeAuth, browserLocalPersistence, browserPopupRedirectResolver, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut,
} from "https://www.gstatic.com/firebasejs/13.0.0/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, onSnapshot, setDoc, addDoc, updateDoc, deleteDoc, getDoc,
  serverTimestamp, Timestamp,
} from "https://www.gstatic.com/firebasejs/13.0.0/firebase-firestore.js";
import * as chrono from "https://esm.sh/chrono-node@2.10.3";
import { loadModel, embed, rank } from "./search.js";
import { VERSION } from "./version.js";

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
// Sign-in is kept in localStorage, not Firebase's default IndexedDB: all of Alex's sites share
// one origin and so one sign-in database, and Firebase waits forever if another site's page
// blocks opening it (seen on Android 2026-11-02: blank page until site data was cleared).
const auth = initializeAuth(app, { persistence: browserLocalPersistence, popupRedirectResolver: browserPopupRedirectResolver });
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

const VIEWS = ["scratch", "tasks", "ideas", "thoughts", "facts"];
// Ideas, thoughts and facts share the Library tab, which reopens whichever was used last.
const LIBRARY = ["ideas", "thoughts", "facts"];
const LIBRARY_KEY = "notes.libraryView"; // localStorage is shared by all of Alex's sites, so prefix it
const OLD_HASHES = { urgent: "tasks" }; // old links and home-screen shortcuts

function currentView() {
  const hash = location.hash.slice(1);
  const view = OLD_HASHES[hash] ?? hash;
  return VIEWS.includes(view) ? view : "scratch";
}

function route() {
  const view = currentView();
  const inLibrary = LIBRARY.includes(view);
  if (inLibrary) {
    localStorage.setItem(LIBRARY_KEY, view);
    $("library-tab").href = `#${view}`;
  }
  for (const v of VIEWS) $(`view-${v}`).hidden = v !== view;
  $("subtabs").hidden = !inLibrary;
  for (const a of document.querySelectorAll("#subtabs a")) a.classList.toggle("active", a.dataset.view === view);
  for (const a of document.querySelectorAll("#tabs a")) {
    a.classList.toggle("active", a.dataset.view === (inLibrary ? "library" : view));
  }
  $("view-title").textContent = $(`view-${view}`).dataset.title;
  if (view === "facts") startSemanticSearch();
}
{
  const saved = localStorage.getItem(LIBRARY_KEY);
  if (LIBRARY.includes(saved)) $("library-tab").href = `#${saved}`;
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

const scratchClear = $("scratch-clear");
function updateScratchClear() { scratchClear.hidden = !scratch.value; }

scratchClear.addEventListener("click", async () => {
  if (!confirm("Clear the scratch pad?")) return;
  scratch.value = "";
  updateScratchClear();
  await saveScratch();
  scratch.focus();
});

scratch.addEventListener("input", () => {
  updateScratchClear();
  setStatus("Editing…");
  clearTimeout(scratchTimer);
  scratchTimer = setTimeout(saveScratch, SAVE_DELAY_MS);
});

// ---------- rendering ----------

function noteItem(note, { leading, actions = [], meta, extraClass = "", onTag } = {}) {
  const tags = onTag && note.tags?.length
    ? el("div", { class: "tags" }, ...note.tags.map((t) => el("button", {
      type: "button", class: "tag", textContent: t, title: `Show only “${t}”`,
      onclick: (e) => { e.stopPropagation(); onTag(t); },
    })))
    : null;
  const body = el("div", { class: "body", onclick: () => openEditor(note) },
    el("div", { class: "text", textContent: note.text }),
    tags,
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

function renderTasks() {
  const tasks = notes.filter((n) => n.type === "task");
  const open = tasks.filter((n) => !n.done)
    .sort((a, b) => (toDate(a.due)?.getTime() ?? Infinity) - (toDate(b.due)?.getTime() ?? Infinity));
  const done = tasks.filter((n) => n.done).sort((a, b) => toDate(b.updatedAt) - toDate(a.updatedAt));
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
  fillList($("task-list"), open.map(item), "No tasks 🎉");
  $("task-done").replaceChildren(...done.map(item));
  $("task-done-count").textContent = done.length;
  $("task-done-wrap").hidden = !done.length;

  const overdue = open.filter((n) => n.due && toDate(n.due) < now).length;
  $("task-badge").textContent = overdue;
  $("task-badge").hidden = !overdue;
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

  const item = (n) => noteItem(n, { meta: toDate(n.createdAt)?.toLocaleDateString(), actions: moveActions(n) });
  fillList($("thought-new"), fresh.map(item), "Nothing new since your last review");
  fillList($("thought-old"), older.map(item), "Nothing here");
  $("thought-archived").replaceChildren(...archived.map(item));
  $("thought-archived-count").textContent = archived.length;
  $("thought-archived-wrap").hidden = !archived.length;
  $("thoughts-reviewed").hidden = !fresh.length;
  for (const id of ["thought-badge", "thought-subbadge"]) {
    $(id).textContent = fresh.length;
    $(id).hidden = !fresh.length;
  }
}

// → Task / → Fact / Archive buttons on thoughts and ideas.
function moveActions(n) {
  const convert = (type, label) => el("button", {
    type: "button", class: "small", textContent: label,
    onclick: () => guard(updateDoc(doc(notesCol, n.id), { type, updatedAt: serverTimestamp() }), "move"),
  });
  return [
    convert("task", "→ Task"),
    convert("fact", "→ Fact"),
    el("button", {
      type: "button", class: "small", textContent: n.archived ? "Unarchive" : "Archive",
      onclick: () => guard(updateDoc(doc(notesCol, n.id), { archived: !n.archived, updatedAt: serverTimestamp() }), "archive"),
    }),
  ];
}

// ---------- idea tags ----------

let ideaFilter = null; // show only ideas with this tag
let newIdeaTag = ""; // tag picked in the idea dock; kept for the next idea too

// Every tag used on any idea (archived too), A–Z.
function usedTags() {
  const tags = new Set(notes.filter((n) => n.type === "idea").flatMap((n) => n.tags ?? []));
  return [...tags].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

// Tidy a typed tag; reuse an existing tag's spelling if it differs only in case.
function cleanTag(raw) {
  const tag = raw.trim().replace(/\s+/g, " ");
  if (!tag) return "";
  return usedTags().find((t) => t.toLowerCase() === tag.toLowerCase()) ?? tag;
}

function setIdeaFilter(tag) {
  ideaFilter = ideaFilter === tag ? null : tag;
  renderIdeas();
}

function renderTagPickers(tags) {
  // Dock dropdown: No tag / every used tag / New tag…
  const pick = $("idea-tag");
  const options = newIdeaTag && !tags.includes(newIdeaTag) ? [...tags, newIdeaTag] : tags;
  pick.replaceChildren(
    el("option", { value: "", textContent: "🏷 No tag" }),
    ...options.map((t) => el("option", { value: t, textContent: `🏷 ${t}` })),
    el("option", { value: "__new", textContent: "+ New tag…" }));
  pick.value = newIdeaTag;
  // Editor suggestions.
  $("tag-options").replaceChildren(...tags.map((t) => el("option", { value: t })));
}

$("idea-tag").addEventListener("change", (e) => {
  if (e.target.value === "__new") {
    newIdeaTag = cleanTag(prompt("New tag") ?? "") || newIdeaTag;
  } else {
    newIdeaTag = e.target.value;
  }
  renderTagPickers(usedTags());
});

function renderIdeas() {
  const ideas = notes.filter((n) => n.type === "idea")
    .sort((a, b) => toDate(b.createdAt) - toDate(a.createdAt));
  const tags = usedTags();
  if (ideaFilter && !tags.includes(ideaFilter)) ideaFilter = null;
  $("idea-filter").hidden = !tags.length;
  $("idea-filter").replaceChildren(
    el("button", { type: "button", class: `chip${ideaFilter ? "" : " active"}`, textContent: "All", onclick: () => setIdeaFilter(null) }),
    ...tags.map((t) => el("button", {
      type: "button", class: `chip${ideaFilter === t ? " active" : ""}`, textContent: t, onclick: () => setIdeaFilter(t),
    })));
  renderTagPickers(tags);

  const shown = ideaFilter ? ideas.filter((n) => n.tags?.includes(ideaFilter)) : ideas;
  const item = (n) => noteItem(n, {
    meta: toDate(n.createdAt)?.toLocaleDateString(), actions: moveActions(n), onTag: setIdeaFilter,
  });
  const archived = shown.filter((n) => n.archived);
  fillList($("idea-list"), shown.filter((n) => !n.archived).map(item), ideaFilter ? `No ideas tagged “${ideaFilter}”` : "No ideas yet");
  $("idea-archived").replaceChildren(...archived.map(item));
  $("idea-archived-count").textContent = archived.length;
  $("idea-archived-wrap").hidden = !archived.length;
}

function renderAll() {
  renderTasks();
  renderIdeas();
  renderThoughts();
  renderFacts();
}
// Keep "in 2 hours" / overdue state fresh.
setInterval(renderTasks, 60_000);

// ---------- capture forms ----------

// Task due date: one-tap chips (Today / Tomorrow / +1 week), the native date-time
// picker (📅), or a date typed in the text ("dentist fri 3pm"). A tapped chip or picked
// date wins over typed text. The chosen time lives in the hidden #task-due input.
let dueTouched = false;
let dueChip = null; // "today" | "tomorrow" | "week" | "custom" | null

function chipDate(kind) {
  const d = new Date();
  if (kind === "today") {
    d.setHours(17, 0, 0, 0); // end of the working day...
    if (d <= Date.now()) { // ...or an hour from now (rounded up) if that's already past
      d.setTime(Date.now() + 60 * 60_000);
      d.setMinutes(Math.ceil(d.getMinutes() / 15) * 15, 0, 0);
    }
    return d;
  }
  d.setDate(d.getDate() + (kind === "tomorrow" ? 1 : 7));
  d.setHours(DEFAULT_DUE_HOUR, 0, 0, 0);
  return d;
}

function setDue(date, chip) {
  $("task-due").value = toLocalInput(date);
  dueChip = date ? chip : null;
  for (const b of document.querySelectorAll("#task-form .chip")) b.classList.toggle("active", b.dataset.due === dueChip);
  // The 📅 chip shows the chosen date when it came from the picker or the typed text.
  $("due-pick").querySelector("span").textContent = dueChip === "custom"
    ? date.toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })
    : "Pick";
}

for (const chip of document.querySelectorAll("#task-form .chip")) {
  // Keep focus (and the keyboard) on the text box while tapping chips.
  chip.addEventListener("pointerdown", (e) => e.preventDefault());
}
for (const chip of document.querySelectorAll("#task-form .chip:not(#due-pick)")) {
  chip.addEventListener("click", () => {
    const kind = chip.dataset.due;
    if (dueChip === kind) { // tap again to clear
      dueTouched = false;
      setDue(parseDue($("task-text").value)?.date ?? null, "custom");
    } else {
      dueTouched = true;
      setDue(chipDate(kind), kind);
    }
    $("task-text").focus();
  });
}
$("due-pick").addEventListener("click", () => {
  const input = $("task-due");
  if (!input.value) input.value = toLocalInput(chipDate("tomorrow"));
  try { input.showPicker(); } catch { input.focus(); }
});
$("task-due").addEventListener("change", () => {
  dueTouched = true;
  setDue(fromLocalInput($("task-due").value), "custom");
});

$("task-text").addEventListener("input", () => {
  if (dueTouched) return;
  setDue(parseDue($("task-text").value)?.date ?? null, "custom");
});
// Tasks are usually one line: Enter adds it (as when this was a single-line input);
// Shift+Enter starts a new line.
$("task-text").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    e.target.form.requestSubmit();
  }
});

$("task-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const raw = $("task-text").value.trim();
  if (!raw) {
    // Empty Add opens the bigger editor, keeping any due date already chosen.
    openEditor({ type: "task", text: "", due: fromLocalInput($("task-due").value) });
    return;
  }
  const parsed = parseDue(raw);
  const due = fromLocalInput($("task-due").value);
  // Only strip the date words when the due time still comes from them.
  const text = parsed && !dueTouched ? parsed.text : raw;
  $("task-form").reset();
  dueTouched = false;
  setDue(null);
  $("task-text").focus(); // keep the keyboard up for the next one
  await guard(addDoc(notesCol, {
    type: "task", text, due: due ? Timestamp.fromDate(due) : null, done: false,
    createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
  }), "add");
});

let pendingFactImage = null;
$("fact-image").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  pendingFactImage = await compressImage(file);
  $("fact-image-preview").src = pendingFactImage;
  $("fact-image-row").hidden = false;
});
function clearFactImage() {
  pendingFactImage = null;
  $("fact-image").value = "";
  $("fact-image-row").hidden = true;
}
$("fact-image-clear").addEventListener("click", clearFactImage);

$("fact-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = $("fact-text").value.trim();
  if (!text && !pendingFactImage) {
    openEditor({ type: "fact", text: "" }); // empty Add opens the bigger editor
    return;
  }
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
  if (!text) {
    openEditor({ type: "thought", text: "" }); // empty Add opens the bigger editor
    return;
  }
  $("thought-text").value = "";
  await guard(addDoc(notesCol, {
    type: "thought", text, archived: false,
    createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
  }), "add");
});

$("idea-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = $("idea-text").value.trim();
  if (!text) {
    openEditor({ type: "idea", text: "", tags: newIdeaTag ? [newIdeaTag] : [] }); // empty Add opens the bigger editor
    return;
  }
  $("idea-text").value = "";
  await guard(addDoc(notesCol, {
    type: "idea", text, archived: false, tags: newIdeaTag ? [newIdeaTag] : [],
    createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
  }), "add");
});

$("thoughts-reviewed").addEventListener("click", () =>
  guard(setDoc(userRef, { thoughtsReviewedAt: serverTimestamp() }, { merge: true }), "save"));

// Ctrl/Cmd+Enter submits the multi-line capture boxes.
for (const id of ["fact-text", "thought-text", "idea-text"]) {
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
// The search box shares the fact form; Enter should just close the keyboard, not add a fact.
$("fact-search").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    e.target.blur();
  }
});

// ---------- edit dialog ----------

const dialog = $("edit");
let editing = null; // {note, image, tags}; a note without an id is a new note

function openEditor(note) {
  editing = { note, image: note.image ?? null, tags: [...(note.tags ?? [])] };
  $("edit-tag-input").value = "";
  dialog.returnValue = "";
  $("edit-type").value = note.type;
  $("edit-text").value = note.text;
  $("edit-due").value = toLocalInput(toDate(note.due));
  $("edit-delete").hidden = !note.id;
  $("edit-save").textContent = note.id ? "Save" : "Add";
  syncEditorFields();
  dialog.showModal();
  if (!note.id) $("edit-text").focus();
}

function syncEditorFields() {
  const type = $("edit-type").value;
  $("edit-due-wrap").hidden = type !== "task";
  $("edit-tags-wrap").hidden = type !== "idea";
  $("edit-tags").replaceChildren(...editing.tags.map((t) => el("button", {
    type: "button", class: "tag", textContent: `${t} ✕`, ariaLabel: `Remove tag ${t}`,
    onclick: () => { editing.tags = editing.tags.filter((x) => x !== t); syncEditorFields(); },
  })));
  $("edit-image-wrap").hidden = type !== "fact" && !editing.image;
  $("edit-image").hidden = !editing.image;
  $("edit-image-remove").hidden = !editing.image;
  $("edit-image-label").textContent = editing.image ? "📷 Replace photo" : "📷 Add photo";
  if (editing.image) $("edit-image").src = editing.image;
}
$("edit-type").addEventListener("change", syncEditorFields);

function addEditorTag() {
  const tag = cleanTag($("edit-tag-input").value);
  $("edit-tag-input").value = "";
  if (tag && !editing.tags.includes(tag)) editing.tags.push(tag);
  syncEditorFields();
}
$("edit-tag-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === ",") {
    e.preventDefault(); // Enter would otherwise submit (and close) the dialog
    addEditorTag();
  }
});
// Picking a suggestion from the dropdown adds it straight away.
$("edit-tag-input").addEventListener("input", (e) => {
  if (!(e instanceof InputEvent) || e.inputType === "insertReplacementText") addEditorTag();
});

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
  if ($("edit-tag-input").value.trim()) addEditorTag(); // typed but not yet added
  const { note, image, tags } = editing;
  const type = $("edit-type").value;
  const text = $("edit-text").value.trim();
  const due = fromLocalInput($("edit-due").value);
  dialog.returnValue = "";
  if (!note.id) {
    await addFromEditor(type, text, due, image, tags);
    return;
  }
  const changes = { type, text, image, updatedAt: serverTimestamp() };
  if (type === "task") {
    changes.due = due ? Timestamp.fromDate(due) : null;
    changes.done = note.type === "task" ? Boolean(note.done) : false;
  }
  if ((type === "thought" || type === "idea") && type !== note.type) changes.archived = false;
  if (type === "idea") changes.tags = tags;
  if (text !== note.text || type !== note.type) changes.embedding = null; // recomputed by backfill
  await guard(updateDoc(doc(notesCol, note.id), changes), "save");
  backfillEmbeddings();
});

// Add a new note written in the editor dialog (opened by Add with an empty box).
async function addFromEditor(type, text, due, image, tags) {
  if (!text && !(type === "fact" && image)) return;
  const note = { type, text, createdAt: serverTimestamp(), updatedAt: serverTimestamp() };
  if (type === "task") {
    // Like the quick-add box: with no due date set, take it from the text ("dentist fri 3pm").
    const parsed = due ? null : parseDue(text);
    if (parsed) { note.text = parsed.text; due = parsed.date; }
    Object.assign(note, { due: due ? Timestamp.fromDate(due) : null, done: false });
    $("task-form").reset();
    dueTouched = false;
    setDue(null);
  } else if (type === "fact") {
    Object.assign(note, { image, embedding: null });
  } else {
    note.archived = false;
    if (type === "idea") note.tags = tags;
  }
  await guard(addDoc(notesCol, note), "add");
  if (type === "fact") backfillEmbeddings();
}

// ---------- auth & live data ----------

// Tasks were called "urgent" notes until 2026-11-03; rename any still stored that way.
function migrateUrgentToTask(docs) {
  for (const d of docs) {
    if (d.data().type === "urgent") updateDoc(d.ref, { type: "task" }).catch((err) => console.warn("migrate", err));
  }
}

// One-time copy of the original single note into the scratch pad.
async function migrateOldNote(user) {
  if (userData.scratch !== undefined) return;
  const old = await getDoc(doc(db, "notes", user.uid)).catch(() => null);
  const text = old?.data()?.text;
  if (text) await setDoc(userRef, { scratch: text, scratchUpdatedAt: serverTimestamp() }, { merge: true });
}

onAuthStateChanged(auth, (user) => {
  $("boot").hidden = true;
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
  $("signout").title = user ? `Signed in as ${user.email}` : "";

  if (!user) {
    userRef = notesCol = null;
    scratch.value = "";
    updateScratchClear();
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
    updateScratchClear();
    renderThoughts();
    setStatus(snap.metadata.fromCache ? "Offline — changes will sync later" : "Saved");
    if (!migrated && !snap.metadata.fromCache) {
      migrated = true;
      migrateOldNote(user);
    }
  }, (err) => setStatus(`Couldn't load: ${err.message}`, true)));

  unsubs.push(onSnapshot(notesCol, (snap) => {
    notes = snap.docs.map((d) => {
      const n = { id: d.id, ...d.data({ serverTimestamps: "estimate" }) };
      if (n.type === "urgent") n.type = "task";
      return n;
    });
    if (!snap.metadata.fromCache) migrateUrgentToTask(snap.docs);
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

// On-screen keyboard detection: with interactive-widget=resizes-content the window
// shrinks when the keyboard opens. While it's open, style.css hides the tab bar so the
// list keeps more room above the input dock.
let fullHeight = window.innerHeight;
let fullWidth = window.innerWidth;
function updateKeyboard() {
  if (window.innerWidth !== fullWidth) { // rotation: start measuring afresh
    fullWidth = window.innerWidth;
    fullHeight = window.innerHeight;
  }
  fullHeight = Math.max(fullHeight, window.innerHeight);
  const typing = document.activeElement?.matches("input, textarea");
  document.body.classList.toggle("keyboard", Boolean(typing) && window.innerHeight < fullHeight * 0.8);
}
window.addEventListener("resize", updateKeyboard);
document.addEventListener("focusout", () => setTimeout(updateKeyboard, 0));

route();

// ---------- version check ----------
// The update light is shared by Alex's Pages sites (github.com/alexknight0/pages-common).
// Loaded dynamically so the notes still work if jsDelivr is unreachable.
import("https://cdn.jsdelivr.net/gh/alexknight0/pages-common@1.0.0/update.js")
  .then(({ initUpdateLight }) => initUpdateLight({
    version: VERSION,
    buttons: "#version",
    report: (text) => setStatus(text),
    async beforeUpdate() {
      if (scratchTimer) await saveScratch().catch(() => {});
    },
  }))
  .catch((e) => {
    console.warn("update light:", e);
    for (const b of document.querySelectorAll(".version")) {
      b.dataset.state = "unknown";
      b.title = "Couldn't load the update check (offline?).";
    }
  });

// Opened from a home-screen shortcut (e.g. ./#tasks): jump straight into the capture box.
if (location.hash) {
  const target = { tasks: "task-text", ideas: "idea-text", facts: "fact-text", thoughts: "thought-text", scratch: "scratch" }[currentView()];
  if (target) setTimeout(() => $(target).focus(), 300);
}
