// Notes app: Google sign-in (Firebase Auth) + Firestore.
// Data (all restricted to the owner by firestore.rules):
//   users/{uid}             { scratch, scratchUpdatedAt, thoughtsReviewedAt }
//   users/{uid}/notes/{id}  { type: "task"|"idea"|"thought"|"fact", text, createdAt, updatedAt,
//                             due?, done?          (task; stored as "urgent" before 2026-11-03,
//                                                   migrated on load by migrateUrgentToTask)
//                             image?, embedding?   (fact; image is a JPEG data URL)
//                             archived?            (idea, thought)
//                             tags?                (idea; array of strings) }
//   users/{uid}/blocks/{id} { text, x, y, w, color, createdAt, updatedAt }  — Project board;
//                             x, y, w are in grid cells (GRID px each), color is a BLOCK_COLORS key
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
let blocksCol = null;
let blocks = []; // project board blocks [{id, ...data}]
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
// "8 Nov" (with the year if it isn't this year), for list items.
function shortDate(date) {
  if (!date) return "";
  const opts = { day: "numeric", month: "short" };
  if (date.getFullYear() !== new Date().getFullYear()) opts.year = "numeric";
  return date.toLocaleDateString(undefined, opts);
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

const VIEWS = ["scratch", "tasks", "ideas", "thoughts", "facts", "project"];
// Ideas, thoughts, facts and the project board share the Library tab, which reopens whichever was used last.
const LIBRARY = ["ideas", "thoughts", "facts", "project"];
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
  const add = ADD_FORMS[view];
  $("header-add").hidden = !add;
  if (add) $("header-add").querySelector("span").textContent = add.word;
  if (view === "facts") startSemanticSearch();
  if (view === "project") renderBoard(); // block heights can only be measured while visible
}
{
  const saved = localStorage.getItem(LIBRARY_KEY);
  if (LIBRARY.includes(saved)) $("library-tab").href = `#${saved}`;
}
window.addEventListener("hashchange", route);

// Desktop: the title-row Add button stands in for the view's dock (whose text box is hidden
// there), so submitting the empty dock form opens the editor as usual.
const ADD_FORMS = {
  tasks: { form: "task-form", word: "task" },
  ideas: { form: "idea-form", word: "idea" },
  thoughts: { form: "thought-form", word: "thought" },
  facts: { form: "fact-form", word: "fact" },
  project: { form: "block-form", word: "block" },
};
$("header-add").addEventListener("click", () => {
  const add = ADD_FORMS[currentView()];
  if (add) $(add.form).requestSubmit();
});

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
    meta: shortDate(toDate(n.createdAt)),
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

  const item = (n) => noteItem(n, { meta: shortDate(toDate(n.createdAt)), actions: moveActions(n) });
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
    meta: shortDate(toDate(n.createdAt)), actions: moveActions(n), onTag: setIdeaFilter,
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
  editing.start = editorState();
  dialog.showModal();
  if (!note.id) $("edit-text").focus();
}

// Everything the user can change in the editor, to tell whether there are unsaved changes.
function editorState() {
  return JSON.stringify([
    $("edit-type").value, $("edit-text").value, $("edit-due").value,
    editing.image, editing.tags, $("edit-tag-input").value.trim(),
  ]);
}
const editorChanged = () => editing && editorState() !== editing.start;

// Escape asks before throwing away changes. Handled on keydown so the dialog's own
// cancel never fires; the cancel listener covers Android's back gesture.
function cancelEditor() {
  if (!editorChanged() || confirm("Discard your changes?")) dialog.close("cancel");
}
dialog.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || e.isComposing) return;
  e.preventDefault();
  cancelEditor();
});
dialog.addEventListener("cancel", (e) => {
  e.preventDefault();
  cancelEditor();
});

// Tab in the text box indents with 4 spaces instead of moving to the next field.
$("edit-text").addEventListener("keydown", (e) => {
  if (e.key !== "Tab" || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey || e.isComposing) return;
  e.preventDefault();
  // execCommand keeps the browser's undo history; setRangeText is the fallback.
  if (!document.execCommand("insertText", false, "    ")) {
    e.target.setRangeText("    ", e.target.selectionStart, e.target.selectionEnd, "end");
  }
});

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

// ---------- project board ----------
// Blocks sit on a grid of GRID px cells. Drag a block to move it (it snaps to the nearest
// cell on release), drag its corner to change its width, tap it to edit. Blocks can overlap;
// the most recently changed one is drawn on top. Heights follow the text, rounded up to whole cells.

const GRID = 24; // px per grid cell
const BLOCK_W = 7; // default width in cells
const MIN_W = 3;
const MAX_W = 40;
const DRAG_SLOP = 5; // px the pointer must move before a press becomes a drag
const BOARD_MARGIN = 6; // spare cells right of and below the last block, room to drag into
const BLOCK_COLORS = { plain: "Plain", yellow: "Yellow", green: "Green", blue: "Blue", pink: "Pink", purple: "Purple" };

const boardWrap = $("board-wrap");
const board = $("board");
let drag = null; // {id, el, mode: "move"|"resize", startX, startY, x, y, w, moved, pointerId}

const blockColor = (b) => (b.color in BLOCK_COLORS ? b.color : "plain");
const cellsOf = (b, el) => ({
  x: b.x ?? 0, y: b.y ?? 0, w: b.w ?? BLOCK_W,
  h: el ? Math.round((el.offsetHeight + 4) / GRID) : 2,
});

function placeBlockEl(el, x, y, w) {
  el.style.left = `${x * GRID + 2}px`;
  el.style.top = `${y * GRID + 2}px`;
  el.style.width = `${w * GRID - 4}px`;
}

// Round a block's height up to whole cells (minus the 4px gap) so its edges sit on grid lines.
function snapHeight(el) {
  el.style.height = "";
  el.style.height = `${Math.max(2, Math.ceil((el.offsetHeight + 4) / GRID)) * GRID - 4}px`;
}

function renderBoard() {
  const byId = new Map([...board.querySelectorAll(".block")].map((el) => [el.dataset.id, el]));
  const order = [...blocks].sort((a, b) => (toDate(a.updatedAt)?.getTime() ?? 0) - (toDate(b.updatedAt)?.getTime() ?? 0));
  const els = order.map((b) => {
    let el = byId.get(b.id);
    if (!el) {
      el = blockEl(b.id);
    }
    el.querySelector(".block-text").textContent = b.text || " ";
    el.dataset.color = blockColor(b);
    el.ariaLabel = `${b.text}. Arrow keys move, Enter edits.`;
    if (drag?.id !== b.id) placeBlockEl(el, b.x ?? 0, b.y ?? 0, b.w ?? BLOCK_W);
    return el;
  });
  // Stacking order = DOM order. Reordering is skipped mid-drag: moving the held block in the
  // DOM would drop its pointer capture (CSS keeps it on top meanwhile).
  for (const [id, el] of byId) if (!els.includes(el)) { el.remove(); byId.delete(id); }
  if (drag) for (const el of els) { if (!el.isConnected) board.append(el); }
  else {
    const focused = document.activeElement;
    const current = [...board.querySelectorAll(".block")];
    if (els.some((el, i) => current[i] !== el)) board.append(...els);
    if (focused?.classList.contains("block") && document.activeElement !== focused) focused.focus({ preventScroll: true });
  }
  for (const el of els) if (drag?.id !== el.dataset.id || drag.mode === "resize") snapHeight(el);
  $("board-empty").hidden = blocks.length > 0;
  sizeBoard();
}

// The board is as big as its blocks plus a margin, and at least as big as the visible area.
function sizeBoard(extra) {
  let cols = 0;
  let rows = 0;
  for (const el of board.querySelectorAll(".block")) {
    const b = blocks.find((x) => x.id === el.dataset.id);
    if (!b) continue;
    const c = cellsOf(b, el);
    cols = Math.max(cols, c.x + c.w);
    rows = Math.max(rows, c.y + c.h);
  }
  if (extra) { cols = Math.max(cols, extra.x + extra.w); rows = Math.max(rows, extra.y + extra.h); }
  board.style.width = `${Math.max((cols + BOARD_MARGIN) * GRID, Math.floor(boardWrap.clientWidth / GRID) * GRID)}px`;
  board.style.height = `${Math.max((rows + BOARD_MARGIN) * GRID, Math.floor(boardWrap.clientHeight / GRID) * GRID)}px`;
}
window.addEventListener("resize", () => { if (!$("view-project").hidden) sizeBoard(); });

function blockEl(id) {
  const node = el("div", { class: "block", tabIndex: 0 },
    el("div", { class: "block-text" }),
    el("div", { class: "block-resize", title: "Drag to resize", ariaHidden: "true" }));
  node.dataset.id = id;
  node.addEventListener("pointerdown", startBlockDrag);
  node.addEventListener("keydown", blockKey);
  return node;
}

function startBlockDrag(e) {
  if (e.button !== 0 || drag) return;
  const el = e.currentTarget;
  const b = blocks.find((x) => x.id === el.dataset.id);
  if (!b) return;
  e.preventDefault(); // no text selection; focus is moved by hand below
  el.focus({ preventScroll: true });
  el.setPointerCapture(e.pointerId);
  const { x, y, w } = cellsOf(b);
  drag = {
    id: b.id, el, mode: e.target.closest(".block-resize") ? "resize" : "move", pointerId: e.pointerId,
    startX: e.clientX, startY: e.clientY, scroll0: [boardWrap.scrollLeft, boardWrap.scrollTop],
    x0: x, y0: y, w0: w, x, y, w, moved: false, lastEvent: e,
  };
  el.addEventListener("pointermove", moveBlockDrag);
  el.addEventListener("pointerup", endBlockDrag);
  el.addEventListener("pointercancel", endBlockDrag);
}

function moveBlockDrag(e) {
  if (!drag || e.pointerId !== drag.pointerId) return;
  drag.lastEvent = e;
  updateDrag();
  if (drag.moved) autoScroll();
}

// Where the block would land, from the pointer position and how far the board has scrolled.
function updateDrag() {
  const e = drag.lastEvent;
  const dx = e.clientX - drag.startX + boardWrap.scrollLeft - drag.scroll0[0];
  const dy = e.clientY - drag.startY + boardWrap.scrollTop - drag.scroll0[1];
  if (!drag.moved && Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < DRAG_SLOP) return;
  if (!drag.moved) {
    drag.moved = true;
    drag.el.classList.add(drag.mode === "move" ? "dragging" : "resizing");
    board.classList.add("active");
  }
  const el = drag.el;
  if (drag.mode === "move") {
    // The block follows the pointer exactly; the shadow cell shows where it will snap.
    drag.x = Math.max(0, Math.round(drag.x0 + dx / GRID));
    drag.y = Math.max(0, Math.round(drag.y0 + dy / GRID));
    el.style.left = `${Math.max(0, drag.x0 * GRID + dx) + 2}px`;
    el.style.top = `${Math.max(0, drag.y0 * GRID + dy) + 2}px`;
  } else {
    drag.w = Math.min(MAX_W, Math.max(MIN_W, Math.round(drag.w0 + dx / GRID)));
    placeBlockEl(el, drag.x, drag.y, drag.w);
    snapHeight(el);
  }
  showGhost(drag.x, drag.y, drag.w, Math.round((el.offsetHeight + 4) / GRID));
  sizeBoard({ x: drag.x, y: drag.y, w: drag.w, h: Math.round((el.offsetHeight + 4) / GRID) });
}

function showGhost(x, y, w, h) {
  let ghost = $("block-ghost");
  if (!ghost) {
    ghost = el("div", { id: "block-ghost", class: "block-ghost" });
    board.prepend(ghost);
  }
  ghost.style.left = `${x * GRID}px`;
  ghost.style.top = `${y * GRID}px`;
  ghost.style.width = `${w * GRID}px`;
  ghost.style.height = `${h * GRID}px`;
}

// Scroll the board while a block is held near its edge, so blocks can go beyond the visible area.
let scrollFrame = 0;
function autoScroll() {
  if (scrollFrame) return;
  const step = () => {
    scrollFrame = 0;
    if (!drag?.moved) return;
    const e = drag.lastEvent;
    const r = boardWrap.getBoundingClientRect();
    const edge = 40;
    const speed = (d) => (d < edge ? Math.ceil((edge - d) / 4) : 0);
    const sx = speed(r.right - e.clientX) - speed(e.clientX - r.left);
    const sy = speed(r.bottom - e.clientY) - speed(e.clientY - r.top);
    if (!sx && !sy) return;
    boardWrap.scrollBy(sx, sy);
    updateDrag();
    scrollFrame = requestAnimationFrame(step);
  };
  scrollFrame = requestAnimationFrame(step);
}

function endBlockDrag(e) {
  if (!drag || e.pointerId !== drag.pointerId) return;
  const d = drag;
  drag = null;
  cancelAnimationFrame(scrollFrame);
  scrollFrame = 0;
  d.el.removeEventListener("pointermove", moveBlockDrag);
  d.el.removeEventListener("pointerup", endBlockDrag);
  d.el.removeEventListener("pointercancel", endBlockDrag);
  d.el.classList.remove("dragging", "resizing");
  board.classList.remove("active");
  $("block-ghost")?.remove();
  const b = blocks.find((x) => x.id === d.id);
  if (!d.moved) {
    renderBoard();
    if (e.type === "pointerup" && b) openBlockEditor(b);
    return;
  }
  if (!b || e.type === "pointercancel" || (d.x === d.x0 && d.y === d.y0 && d.w === d.w0)) {
    renderBoard();
    return;
  }
  moveBlock(b, { x: d.x, y: d.y, w: d.w });
}

// Save a new position/width; shown straight away, before Firestore's own update arrives.
function moveBlock(b, pos) {
  Object.assign(b, pos, { updatedAt: Date.now() });
  renderBoard();
  guard(updateDoc(doc(blocksCol, b.id), { ...pos, updatedAt: serverTimestamp() }), "move block");
}

// Keyboard: arrows move the focused block a cell (Shift = 4 cells), Enter edits, Delete deletes.
function blockKey(e) {
  const b = blocks.find((x) => x.id === e.currentTarget.dataset.id);
  if (!b) return;
  const n = e.shiftKey ? 4 : 1;
  const moves = { ArrowLeft: [-n, 0], ArrowRight: [n, 0], ArrowUp: [0, -n], ArrowDown: [0, n] };
  if (moves[e.key]) {
    e.preventDefault();
    const [dx, dy] = moves[e.key];
    const { x, y } = cellsOf(b);
    if (Math.max(0, x + dx) !== x || Math.max(0, y + dy) !== y) moveBlock(b, { x: Math.max(0, x + dx), y: Math.max(0, y + dy) });
    requestAnimationFrame(() => board.querySelector(`[data-id="${b.id}"]`)?.focus());
  } else if (e.key === "Enter") {
    e.preventDefault();
    openBlockEditor(b);
  } else if (e.key === "Delete" || e.key === "Backspace") {
    e.preventDefault();
    if (confirm("Delete this block?")) guard(deleteDoc(doc(blocksCol, b.id)), "delete block");
  }
}

// First free spot for a new block, starting at the top-left of the visible part of the board.
function freeSpot(w, h) {
  const taken = [...board.querySelectorAll(".block")].map((el) => {
    const b = blocks.find((x) => x.id === el.dataset.id);
    return b ? cellsOf(b, el) : null;
  }).filter(Boolean);
  const overlaps = (x, y) => taken.some((t) => x < t.x + t.w && t.x < x + w && y < t.y + t.h && t.y < y + h);
  const x0 = Math.ceil(boardWrap.scrollLeft / GRID) + 1;
  const y0 = Math.ceil(boardWrap.scrollTop / GRID) + 1;
  const cols = Math.max(w, Math.floor(boardWrap.clientWidth / GRID) - 2);
  for (let y = y0; y < y0 + 400; y++) {
    for (let x = x0; x + w <= x0 + cols; x++) if (!overlaps(x, y)) return { x, y };
  }
  return { x: x0, y: y0 };
}

async function addBlock(text, color = "plain") {
  if (!text) return;
  const w = Math.min(BLOCK_W, Math.max(MIN_W, Math.floor(boardWrap.clientWidth / GRID) - 2));
  const { x, y } = freeSpot(w, 2);
  await guard(addDoc(blocksCol, {
    text, x, y, w, color, createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
  }), "add block");
}

$("block-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = $("block-text").value.trim();
  if (!text) {
    openBlockEditor({ text: "", color: "plain" }); // empty Add opens the bigger editor
    return;
  }
  $("block-text").value = "";
  $("block-text").focus(); // keep the keyboard up for the next one
  await addBlock(text);
});
// Blocks are usually short: Enter adds one, Shift+Enter starts a new line.
$("block-text").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    e.target.form.requestSubmit();
  }
});

// Block editor dialog: text, colour, delete. A block without an id is a new block.
const blockDialog = $("block-edit");
let editingBlock = null; // {block, color, start}
$("block-colors").replaceChildren(...Object.entries(BLOCK_COLORS).map(([key, label]) => el("button", {
  type: "button", class: "swatch", title: label, ariaLabel: label, role: "radio",
  onclick: () => { editingBlock.color = key; syncSwatches(); },
})));
[...$("block-colors").children].forEach((b, i) => { b.dataset.color = Object.keys(BLOCK_COLORS)[i]; });

function syncSwatches() {
  for (const s of $("block-colors").children) s.ariaChecked = String(s.dataset.color === editingBlock.color);
}
const blockEditorState = () => JSON.stringify([$("block-edit-text").value, editingBlock.color]);

function openBlockEditor(block) {
  editingBlock = { block, color: blockColor(block) };
  blockDialog.returnValue = "";
  $("block-edit-text").value = block.text ?? "";
  $("block-delete").hidden = !block.id;
  $("block-save").textContent = block.id ? "Save" : "Add";
  syncSwatches();
  editingBlock.start = blockEditorState();
  blockDialog.showModal();
  if (!block.id) $("block-edit-text").focus();
}
function cancelBlockEditor() {
  if (!editingBlock || blockEditorState() === editingBlock.start || confirm("Discard your changes?")) blockDialog.close("cancel");
}
blockDialog.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !e.isComposing) { e.preventDefault(); cancelBlockEditor(); }
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); blockDialog.close("save"); }
});
blockDialog.addEventListener("cancel", (e) => { e.preventDefault(); cancelBlockEditor(); });
$("block-delete").addEventListener("click", async () => {
  if (!confirm("Delete this block?")) return;
  const { block } = editingBlock;
  blockDialog.close();
  await guard(deleteDoc(doc(blocksCol, block.id)), "delete block");
});
blockDialog.addEventListener("close", async () => {
  if (blockDialog.returnValue !== "save" || !editingBlock) return;
  blockDialog.returnValue = "";
  const { block, color } = editingBlock;
  const text = $("block-edit-text").value.trim();
  if (!block.id) {
    await addBlock(text, color);
    return;
  }
  if (!text) return; // an emptied block is kept; Delete removes it
  await guard(updateDoc(doc(blocksCol, block.id), { text, color, updatedAt: serverTimestamp() }), "save block");
});

// ---------- auth & live data ----------

// Sync status from both listeners' metadata:
//   fromCache         = not (yet) in touch with the server
//   hasPendingWrites  = local edits the server hasn't confirmed
let syncState = {}; // listener name -> metadata
let lastSyncText = "";
function updateSync(name, { fromCache, hasPendingWrites }) {
  syncState[name] = { fromCache, hasPendingWrites };
  const all = Object.values(syncState);
  const offline = all.some((m) => m.fromCache);
  const pending = all.some((m) => m.hasPendingWrites);
  const text = offline
    ? (pending ? "Offline — changes will sync later" : "Offline")
    : pending ? "Not synced yet" : "Saved";
  // Only on a change, so "Editing…" and error messages aren't overwritten by repeat events.
  if (text !== lastSyncText) setStatus(text);
  lastSyncText = text;
}

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

// Who may use Notes is decided by the Firestore rules (Alex, plus config/access.emails, edited
// on Home's Access page), so an account that isn't allowed finds out when loading is refused.
function loadError(user, err, what) {
  if (err.code === "permission-denied") return `${user.email} doesn't have access to Notes. Sign out and use an account that's been given access.`;
  return `Couldn't ${what}: ${err.message}`;
}

onAuthStateChanged(auth, (user) => {
  $("boot").hidden = true;
  unsubs.forEach((u) => u());
  unsubs = [];
  notes = [];
  blocks = [];
  renderBoard();
  userData = {};

  $("signin").hidden = Boolean(user);
  $("signout").hidden = !user;
  $("signed-out-msg").hidden = Boolean(user);
  $("app").hidden = !user;
  $("tabs").hidden = !user;
  $("user-email").textContent = user ? user.email : "";
  $("signout").title = user ? `Signed in as ${user.email}` : "";

  if (!user) {
    userRef = notesCol = blocksCol = null;
    scratch.value = "";
    updateScratchClear();
    setStatus("");
    return;
  }

  userRef = doc(db, "users", user.uid);
  notesCol = collection(userRef, "notes");
  blocksCol = collection(userRef, "blocks");
  setStatus("Loading…");
  let migrated = false;
  syncState = {};
  lastSyncText = "";

  // includeMetadataChanges: also hear when data that came from the device cache is
  // confirmed by the server, or when a pending write is acknowledged. Without it Firestore
  // stays quiet if nothing changed, and the status stuck on "Offline" after reconnecting.
  unsubs.push(onSnapshot(userRef, { includeMetadataChanges: true }, (snap) => {
    userData = snap.data({ serverTimestamps: "estimate" }) ?? {};
    // Don't clobber what the user is typing; local pending writes are our own.
    if (!scratchTimer && !snap.metadata.hasPendingWrites) scratch.value = userData.scratch ?? "";
    updateScratchClear();
    renderThoughts();
    updateSync("user", snap.metadata);
    if (!migrated && !snap.metadata.fromCache) {
      migrated = true;
      migrateOldNote(user);
    }
  }, (err) => setStatus(loadError(user, err, "load"), true)));

  unsubs.push(onSnapshot(notesCol, { includeMetadataChanges: true }, (snap) => {
    notes = snap.docs.map((d) => {
      const n = { id: d.id, ...d.data({ serverTimestamps: "estimate" }) };
      if (n.type === "urgent") n.type = "task";
      return n;
    });
    if (!snap.metadata.fromCache) migrateUrgentToTask(snap.docs);
    renderAll();
    updateSync("notes", snap.metadata);
    backfillEmbeddings();
  }, (err) => setStatus(loadError(user, err, "load notes"), true)));

  unsubs.push(onSnapshot(blocksCol, { includeMetadataChanges: true }, (snap) => {
    blocks = snap.docs.map((d) => ({ id: d.id, ...d.data({ serverTimestamps: "estimate" }) }));
    renderBoard();
    updateSync("blocks", snap.metadata);
  }, (err) => setStatus(loadError(user, err, "load the project board"), true)));
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
  const target = { tasks: "task-text", ideas: "idea-text", facts: "fact-text", thoughts: "thought-text", scratch: "scratch", project: "block-text" }[currentView()];
  if (target) setTimeout(() => $(target).focus(), 300);
}
