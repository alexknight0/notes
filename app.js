// Notes app: Google sign-in (Firebase Auth) + Firestore.
// Data (all restricted to the owner by firestore.rules):
//   users/{uid}             { scratch, scratchUpdatedAt, thoughtsReviewedAt }
//   users/{uid}/notes/{id}  { type: "task"|"idea"|"thought"|"fact", text, createdAt, updatedAt,
//                             due?, done?          (task; stored as "urgent" before 2026-11-03,
//                                                   migrated on load by migrateUrgentToTask)
//                             remindedDue?         (task; = due once its reminder was sent,
//                                                   written by worker/src/index.js)
//                             image?, embedding?   (fact; image is a JPEG data URL)
//                             archived?            (idea, thought)
//                             tags?                (idea; array of strings) }
//   users/{uid}/projects/{id} { name, groups: [{id, name, color}], createdAt, updatedAt } — Projects;
//                             groups are in priority order (top/left first), color is a GROUP_COLORS key
//   users/{uid}/ptasks/{id}  { project, group, text, order, done, doneAt, createdAt, updatedAt } —
//                             a project's tasks; order sorts tasks within a group (oldest first)
//   users/{uid}/blocks/{id} { text, x, y, w, color, createdAt, updatedAt }  — the old Project board
//                             (replaced by Projects on 2026-11-12; the docs are left in place, unused)
//   users/{uid}/devices/{id} { token, timeZone, userAgent, updatedAt } — push reminders; one per
//                             device with reminders on (id is random, kept in localStorage)
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
  messagingSenderId: "901046426288", // push reminders (FCM)
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
let projectsCol = null;
let ptasksCol = null;
let projects = []; // [{id, ...data}]
let ptasks = []; // tasks of every project [{id, ...data}]
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

const VIEWS = ["scratch", "tasks", "ideas", "thoughts", "facts", "projects"];
// Ideas, thoughts, facts and projects share the Library tab, which reopens whichever was used last.
const LIBRARY = ["ideas", "thoughts", "facts", "projects"];
const LIBRARY_KEY = "notes.libraryView"; // localStorage is shared by all of Alex's sites, so prefix it
const OLD_HASHES = { urgent: "tasks", project: "projects" }; // old links and home-screen shortcuts

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
}
{
  const saved = OLD_HASHES[localStorage.getItem(LIBRARY_KEY)] ?? localStorage.getItem(LIBRARY_KEY);
  if (LIBRARY.includes(saved)) $("library-tab").href = `#${saved}`;
}
window.addEventListener("hashchange", route);

// Desktop: the title-row Add button stands in for the view's dock (whose text box is hidden
// there), so submitting the empty dock form opens the editor as usual. Projects has no entry:
// on desktop each group column has its own "+ Add".
const ADD_FORMS = {
  tasks: { form: "task-form", word: "task" },
  ideas: { form: "idea-form", word: "idea" },
  thoughts: { form: "thought-form", word: "thought" },
  facts: { form: "fact-form", word: "fact" },
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

// Pinch-zoom panning on Android. Chrome's "swipe to move cursor" turns any sideways-first
// swipe that starts on an editable text box into caret movement (or nothing, if the box isn't
// focused), so a zoomed-in page couldn't be panned sideways: the pad covers nearly all of it.
// Read-only boxes are exempt, so while zoomed and not typing the pad is read-only, for the
// whole of every touch (Chrome decides how a touch scrolls when it starts). A tap (click)
// then makes it editable and re-focuses it, which opens the keyboard with the caret where
// the tap landed.
const zoomed = () => (window.visualViewport?.scale ?? 1) > 1.01;
function updateScratchLock() {
  scratch.readOnly = zoomed() && document.activeElement !== scratch;
}
scratch.addEventListener("click", () => {
  if (!scratch.readOnly) return;
  const { selectionStart, selectionEnd } = scratch;
  scratch.readOnly = false;
  scratch.blur();
  scratch.focus({ preventScroll: true }); // the keyboard only opens for a focus while editable
  scratch.setSelectionRange(selectionStart, selectionEnd);
});
scratch.addEventListener("blur", () => setTimeout(updateScratchLock, 0));
window.visualViewport?.addEventListener("resize", updateScratchLock);

// ---------- rendering ----------

function noteItem(note, { leading, actions = [], meta, extraClass = "", onTag } = {}) {
  const tags = onTag && note.tags?.length
    ? el("div", { class: "tags" }, ...note.tags.map((t) => el("button", {
      type: "button", class: "tag", textContent: t, title: `Show only “${t}”`,
      onclick: (e) => { e.stopPropagation(); onTag(t); },
    })))
    : null;
  // The date and the action buttons share the bottom line of the card.
  const foot = meta || actions.length
    ? el("div", { class: "foot" },
      el("div", { class: "meta", textContent: meta ?? "" }),
      actions.length ? el("div", { class: "actions", onclick: (e) => e.stopPropagation() }, ...actions) : null)
    : null;
  const body = el("div", { class: "body", onclick: () => openEditor(note) },
    el("div", { class: "text", textContent: note.text }),
    tags,
    foot);
  const thumb = note.image
    ? el("img", { class: "thumb", src: note.image, alt: "", onclick: () => openEditor(note) })
    : null;
  return el("li", { class: extraClass }, leading, thumb, body);
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

// ---------- projects ----------
// Each project has coloured groups in priority order (e.g. Now / Next / Later) holding to-do
// tasks. Phone: one group fills the screen, the map at the top shows every group with its count;
// swipe a task sideways to finish it, swipe empty space (or tap the map) to change group, long-press
// a task and drop it on another group to move it. Wide screens with a mouse: every group side by
// side; the ✓ button (or x) finishes a task, drag a task to another column to move it.
// Finished tasks drop out of the groups into one list per project (▾ menu → Finished tasks).

const PROJECT_KEY = "notes.project"; // last-open project id (localStorage is shared by Alex's sites)
const GROUP_KEY = "notes.projectGroup"; // last-open group id, for the phone's one-group view
const GROUP_COLORS = {
  red: "Red", orange: "Orange", yellow: "Yellow", green: "Green", teal: "Teal",
  blue: "Blue", purple: "Purple", pink: "Pink", grey: "Grey",
};
const DEFAULT_GROUPS = [["Now", "red"], ["Next", "orange"], ["Later", "blue"]];
const SWIPE_DONE = 0.3; // a task swiped this fraction of its width is finished
const SWIPE_GROUP = 60; // px of sideways swipe on empty space that changes group
const GESTURE_SLOP = 8; // px a finger/mouse must move before a press counts as a gesture
const LONG_PRESS_MS = 450; // hold a task this long (without moving) to pick it up
const TOAST_MS = 5000;
const MAP_BARS = 6; // at most this many task lines per group in the map
const wideScreen = window.matchMedia("(min-width: 700px) and (pointer: fine)");

let projectId = localStorage.getItem(PROJECT_KEY);
let groupId = localStorage.getItem(GROUP_KEY);
let gesture = null; // the press/swipe/drag in progress on the board
let renderPending = false; // a data update arrived mid-gesture; render when it ends
let lastDone = null; // id of the task the Undo button would bring back
let toastTimer = 0;

const shortId = () => crypto.randomUUID().slice(0, 8);
const groupColor = (g) => (g?.color in GROUP_COLORS ? g.color : "grey");

function sortedProjects() {
  return [...projects].sort((a, b) => (toDate(a.createdAt)?.getTime() ?? 0) - (toDate(b.createdAt)?.getTime() ?? 0));
}
function currentProject() {
  return projects.find((p) => p.id === projectId) ?? sortedProjects()[0] ?? null;
}
const groupsOf = (p) => p?.groups ?? [];
function currentGroup(p) {
  const groups = groupsOf(p);
  return groups.find((g) => g.id === groupId) ?? groups[0] ?? null;
}
// A task whose group no longer exists (deleted on another device) shows in the first group.
function groupOfTask(t, groups) {
  return groups.some((g) => g.id === t.group) ? t.group : groups[0]?.id;
}
const byOrder = (a, b) => (a.order ?? 0) - (b.order ?? 0) || (toDate(a.createdAt)?.getTime() ?? 0) - (toDate(b.createdAt)?.getTime() ?? 0);
const projectTasks = (p) => ptasks.filter((t) => t.project === p.id);
const openTasksIn = (p, gid) => projectTasks(p).filter((t) => !t.done && groupOfTask(t, groupsOf(p)) === gid).sort(byOrder);
const finishedTasks = (p) => projectTasks(p).filter((t) => t.done)
  .sort((a, b) => (toDate(b.doneAt)?.getTime() ?? 0) - (toDate(a.doneAt)?.getTime() ?? 0));

function setProject(id) {
  projectId = id;
  localStorage.setItem(PROJECT_KEY, id);
  groupId = null;
  renderProjects();
}
function setGroup(id, enterFrom) {
  groupId = id;
  localStorage.setItem(GROUP_KEY, id);
  renderProjects();
  // Slide the new group in from the side it came from.
  const col = document.querySelector(`#proj-board .pcol[data-group="${id}"]`);
  if (enterFrom && col) {
    col.classList.remove("enter-left", "enter-right");
    void col.offsetWidth; // restart the animation
    col.classList.add(enterFrom === "right" ? "enter-right" : "enter-left");
  }
}

// How long a task's line in the map is: longer text, longer line.
const barWidth = (t) => `${Math.min(100, 35 + (t.text?.length ?? 0) * 1.6)}%`;

function renderProjects() {
  if (gesture?.mode) { renderPending = true; return; } // don't yank a card out from under a finger
  renderPending = false;
  const p = currentProject();
  for (const id of ["proj-head", "proj-map", "proj-board"]) $(id).hidden = !p;
  $("proj-empty").hidden = Boolean(p);
  $("proj-add").hidden = !p || !currentGroup(p);
  if (!p) return;
  projectId = p.id;
  const groups = groupsOf(p);
  const current = currentGroup(p);
  groupId = current?.id ?? null;
  const open = projectTasks(p).filter((t) => !t.done);
  $("proj-name").textContent = p.name || "Untitled project";
  $("proj-remaining").textContent = `${open.length} remaining`;

  // The map: every group with its count and a short line per task; the one on screen is outlined.
  $("proj-map").replaceChildren(
    ...groups.map((g) => {
      const tasks = openTasksIn(p, g.id);
      const tile = el("button", {
        type: "button", class: `ptile${g.id === groupId ? " on" : ""}`,
        ariaLabel: `${g.name}: ${tasks.length} task${tasks.length === 1 ? "" : "s"}`,
        onclick: () => setGroup(g.id, groups.indexOf(g) > groups.indexOf(current) ? "right" : "left"),
      },
      el("span", { class: "ptile-label" }, el("span", { class: "ptile-name", textContent: g.name }), el("span", { textContent: tasks.length })),
      el("span", { class: "ptile-bars" }, ...tasks.slice(0, MAP_BARS).map((t) => {
        const bar = el("i");
        bar.style.width = barWidth(t);
        return bar;
      })));
      tile.dataset.group = g.id;
      tile.dataset.g = groupColor(g);
      if (g.id === groupId) tile.ariaCurrent = "true";
      return tile;
    }),
    el("button", { type: "button", class: "ptile ptile-add", textContent: "+", title: "New group", ariaLabel: "New group", onclick: () => openGroupEditor(null) }),
  );

  // The columns: all shown side by side on wide screens, only the current one on phones.
  $("proj-board").replaceChildren(...groups.map((g) => {
    const tasks = openTasksIn(p, g.id);
    const list = el("ul", { class: "plist" }, ...tasks.map(taskCard));
    if (!tasks.length) list.append(el("li", { class: "pempty", textContent: "Nothing here" }));
    const col = el("section", { class: `pcol${g.id === groupId ? " current" : ""}`, ariaLabel: g.name },
      el("h2", { class: "pcol-head" },
        el("span", { class: "pcol-name", textContent: g.name }),
        el("span", { class: "pcol-count", textContent: tasks.length }),
        el("button", { type: "button", class: "pcol-more", textContent: "···", title: "Edit group", ariaLabel: `Edit group ${g.name}`, onclick: () => openGroupEditor(g) })),
      list,
      el("button", { type: "button", class: "pcol-add", textContent: "+ Add", onclick: () => openTaskEditor({ group: g.id }) }));
    col.dataset.group = g.id;
    col.dataset.g = groupColor(g);
    return col;
  }));
}

function taskCard(t) {
  const card = el("li", { class: "pcard", tabIndex: 0, ariaLabel: `${t.text}. Enter edits, x finishes.` },
    el("span", { class: "pcard-under", ariaHidden: "true", textContent: "✓ Done" }),
    el("div", { class: "pcard-body" },
      el("span", { class: "pcard-text", textContent: t.text }),
      el("button", {
        type: "button", class: "pcard-done", textContent: "✓", title: "Done (x)", ariaLabel: "Done",
        onclick: (e) => { e.stopPropagation(); finishTask(t); },
      })));
  card.dataset.id = t.id;
  card.addEventListener("keydown", (e) => taskKey(e, t));
  card.addEventListener("contextmenu", (e) => { if (e.pointerType !== "mouse") e.preventDefault(); }); // long-press is ours
  return card;
}

// ----- finishing, moving, undo -----

async function finishTask(t) {
  lastDone = t.id;
  showToast();
  await guard(updateDoc(doc(ptasksCol, t.id), { done: true, doneAt: serverTimestamp(), updatedAt: serverTimestamp() }), "finish the task");
}
async function unfinishTask(id) {
  const t = ptasks.find((x) => x.id === id);
  if (!t) return;
  // Back at the end of its group, or the first group if its own has gone.
  const p = projects.find((x) => x.id === t.project);
  await guard(updateDoc(doc(ptasksCol, id), {
    done: false, doneAt: null, group: groupOfTask(t, groupsOf(p)) ?? t.group, order: Date.now(), updatedAt: serverTimestamp(),
  }), "put the task back");
}
function moveTask(t, gid) {
  if (!gid || t.group === gid) return;
  // Shown straight away, before Firestore's own update arrives.
  Object.assign(t, { group: gid, order: Date.now() });
  renderProjects();
  guard(updateDoc(doc(ptasksCol, t.id), { group: gid, order: t.order, updatedAt: serverTimestamp() }), "move the task");
}

function showToast() {
  $("proj-toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, TOAST_MS);
}
function hideToast() {
  clearTimeout(toastTimer);
  $("proj-toast").hidden = true;
}
$("proj-toast-undo").addEventListener("click", () => {
  hideToast();
  if (lastDone) unfinishTask(lastDone);
  lastDone = null;
});
$("proj-toast-finished").addEventListener("click", () => { hideToast(); openFinished(); });

// Keyboard on a focused task: x finishes, Enter edits, [ and ] move it to the previous/next group.
function taskKey(e, t) {
  if (e.target !== e.currentTarget || e.ctrlKey || e.metaKey || e.altKey) return;
  const p = currentProject();
  const groups = groupsOf(p);
  const i = groups.findIndex((g) => g.id === groupOfTask(t, groups));
  if (e.key === "x") {
    e.preventDefault();
    focusNeighbour(e.currentTarget);
    finishTask(t);
  } else if (e.key === "Enter") {
    e.preventDefault();
    openTaskEditor({ task: t });
  } else if ((e.key === "[" || e.key === "]") && groups.length > 1) {
    e.preventDefault();
    const target = groups[i + (e.key === "]" ? 1 : -1)];
    if (!target) return;
    moveTask(t, target.id);
    if (!wideScreen.matches) setGroup(target.id, e.key === "]" ? "right" : "left");
    requestAnimationFrame(() => document.querySelector(`.pcard[data-id="${t.id}"]`)?.focus());
  } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const cards = [...e.currentTarget.parentElement.querySelectorAll(".pcard")];
    cards[cards.indexOf(e.currentTarget) + (e.key === "ArrowDown" ? 1 : -1)]?.focus();
  }
}
// After finishing the focused task, keep the keyboard going with the next one.
function focusNeighbour(card) {
  const next = card.nextElementSibling?.matches(".pcard") ? card.nextElementSibling : card.previousElementSibling;
  if (next?.dataset.id) requestAnimationFrame(() => document.querySelector(`.pcard[data-id="${next.dataset.id}"]`)?.focus());
}
// z (not while typing) = Undo, while the Undo bar is up.
document.addEventListener("keydown", (e) => {
  if (e.key !== "z" || e.ctrlKey || e.metaKey || e.altKey || currentView() !== "projects") return;
  if (e.target.matches("input, textarea") || document.querySelector("dialog[open]") || $("proj-toast").hidden) return;
  e.preventDefault();
  $("proj-toast-undo").click();
});

// ----- touch and mouse gestures on the board -----
// Touch: sideways on a task = finish it; sideways on empty space = next/previous group; hold a
// task still for LONG_PRESS_MS = pick it up (drop it on a group in the map). Vertical = scroll.
// Mouse: press and move a task = drag it to another column; click = edit.

const projBoard = $("proj-board");

// Pinch-zoomed: no swipe gestures, so a sideways swipe pans the zoomed page (see the scratch pad).
const updateProjZoom = () => $("view-projects").classList.toggle("zoomed", zoomed());
window.visualViewport?.addEventListener("resize", updateProjZoom);

projBoard.addEventListener("pointerdown", (e) => {
  if (e.button !== 0 || gesture || e.target.closest("button")) return;
  if (e.pointerType !== "mouse" && zoomed()) { // a tap still opens the task
    const card = e.target.closest(".pcard");
    const t = card && ptasks.find((x) => x.id === card.dataset.id);
    if (t) gesture = { pointerId: e.pointerId, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, card, task: t, mouse: false, mode: null, zoomTap: true };
    return;
  }
  const card = e.target.closest(".pcard");
  const mouse = e.pointerType === "mouse";
  if (mouse && !card) return; // no group swiping with a mouse; every column is on screen
  const t = card && ptasks.find((x) => x.id === card.dataset.id);
  if (card && !t) return;
  gesture = { pointerId: e.pointerId, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, card, task: t, mouse, mode: null };
  if (card && !mouse) gesture.timer = setTimeout(() => startTaskDrag(), LONG_PRESS_MS);
});

window.addEventListener("pointermove", (e) => {
  if (!gesture || e.pointerId !== gesture.pointerId) return;
  const g = gesture;
  g.x = e.clientX;
  g.y = e.clientY;
  const dx = g.x - g.x0;
  const dy = g.y - g.y0;
  if (!g.mode) {
    if (Math.hypot(dx, dy) < GESTURE_SLOP) return;
    clearTimeout(g.timer);
    if (g.zoomTap) { g.mode = "none"; return; }
    if (g.mouse) startTaskDrag();
    else if (Math.abs(dx) > Math.abs(dy)) {
      g.mode = g.card ? "swipe" : wideScreen.matches ? "none" : "page";
      if (g.mode === "swipe") g.card.classList.add("swiping");
    } else g.mode = "scroll"; // the browser scrolls the list (touch-action: pan-y)
  }
  if (g.mode === "swipe") {
    g.card.dataset.dir = dx > 0 ? "right" : "left";
    g.card.querySelector(".pcard-body").style.transform = `translateX(${dx}px)`;
    g.card.classList.toggle("armed", Math.abs(dx) > g.card.offsetWidth * SWIPE_DONE);
  } else if (g.mode === "page") {
    const col = projBoard.querySelector(".pcol.current");
    if (col) col.style.transform = `translateX(${dx * 0.4}px)`;
  } else if (g.mode === "drag") {
    moveDragGhost();
  }
});

// While a task is picked up on a touch screen, the finger moves it rather than scrolling the list.
projBoard.addEventListener("touchmove", (e) => { if (gesture?.mode === "drag") e.preventDefault(); }, { passive: false });

function endGesture(e) {
  if (!gesture || e.pointerId !== gesture.pointerId) return;
  const g = gesture;
  gesture = null;
  clearTimeout(g.timer);
  const dx = g.x - g.x0;
  const cancelled = e.type === "pointercancel";
  if (!g.mode && g.card && !cancelled) {
    openTaskEditor({ task: g.task }); // a tap or click
  } else if (g.mode === "swipe") {
    const body = g.card.querySelector(".pcard-body");
    if (!cancelled && Math.abs(dx) > g.card.offsetWidth * SWIPE_DONE) {
      // Slide the rest of the way off, then finish it.
      body.style.transition = "transform 0.18s ease-in";
      body.style.transform = `translateX(${Math.sign(dx) * g.card.offsetWidth * 1.1}px)`;
      g.card.classList.add("leaving");
      setTimeout(() => finishTask(g.task), 160);
    } else {
      body.style.transition = "transform 0.18s ease-out";
      body.style.transform = "";
      setTimeout(() => g.card.classList.remove("swiping", "armed"), 180);
    }
  } else if (g.mode === "page") {
    const col = projBoard.querySelector(".pcol.current");
    if (col) col.style.transform = "";
    const groups = groupsOf(currentProject());
    const i = groups.findIndex((x) => x.id === groupId);
    const next = !cancelled && Math.abs(dx) > SWIPE_GROUP ? groups[i + (dx < 0 ? 1 : -1)] : null;
    if (next) setGroup(next.id, dx < 0 ? "right" : "left");
  } else if (g.mode === "drag") {
    endTaskDrag(g, cancelled);
  }
  if (renderPending) renderProjects();
}
window.addEventListener("pointerup", endGesture);
window.addEventListener("pointercancel", endGesture);

// Pick up a task: a floating copy follows the pointer; groups in the map and columns are drop targets.
function startTaskDrag() {
  const g = gesture;
  if (!g?.card || g.mode) return;
  g.mode = "drag";
  navigator.vibrate?.(15);
  const r = g.card.getBoundingClientRect();
  g.offset = [g.x0 - r.left, g.y0 - r.top];
  g.ghost = g.card.cloneNode(true);
  g.ghost.className = "pcard pdrag-ghost";
  g.ghost.style.width = `${r.width}px`;
  document.body.append(g.ghost);
  g.card.classList.add("lifted");
  $("view-projects").classList.add("dragging");
  moveDragGhost();
}
function dropTargetAt(x, y) {
  const hit = document.elementFromPoint(x, y)?.closest("[data-group]");
  return hit && $("view-projects").contains(hit) ? hit : null;
}
function moveDragGhost() {
  const g = gesture;
  g.ghost.style.left = `${g.x - g.offset[0]}px`;
  g.ghost.style.top = `${g.y - g.offset[1]}px`;
  const target = dropTargetAt(g.x, g.y);
  for (const n of document.querySelectorAll("#view-projects .drop-over")) if (n !== target) n.classList.remove("drop-over");
  target?.classList.add("drop-over");
}
function endTaskDrag(g, cancelled) {
  g.ghost.remove();
  g.card.classList.remove("lifted");
  $("view-projects").classList.remove("dragging");
  for (const n of document.querySelectorAll("#view-projects .drop-over")) n.classList.remove("drop-over");
  const target = cancelled ? null : dropTargetAt(g.x, g.y);
  if (target) moveTask(g.task, target.dataset.group);
}

// ----- the "+ Add" / task editor dialog -----
// New tasks go into the group they were added from (no group picker, to keep it simple);
// editing an existing task can move it to another group.

const ptaskDialog = $("ptask-edit");
let editingTask = null; // {task?, group, start}

function openTaskEditor({ task = null, group = null }) {
  const p = currentProject();
  if (!p) return;
  const groups = groupsOf(p);
  editingTask = { task, group: task ? groupOfTask(task, groups) : group ?? currentGroup(p)?.id };
  if (!editingTask.group) return;
  const g = groups.find((x) => x.id === editingTask.group);
  ptaskDialog.returnValue = "";
  $("ptask-title").replaceChildren(task ? "Edit task" : "New task in ", task ? "" : el("span", { class: "gname", textContent: g.name }));
  $("ptask-title").dataset.g = groupColor(g);
  $("ptask-text").value = task?.text ?? "";
  $("ptask-delete").hidden = !task;
  $("ptask-save").textContent = task ? "Save" : "Add";
  $("ptask-groups").hidden = !task || groups.length < 2;
  syncTaskGroups();
  editingTask.start = taskEditorState();
  ptaskDialog.showModal();
  if (!task) $("ptask-text").focus();
}
function syncTaskGroups() {
  const groups = groupsOf(currentProject());
  $("ptask-groups").replaceChildren(...groups.map((g) => {
    const chip = el("button", {
      type: "button", class: `chip pchip${g.id === editingTask.group ? " active" : ""}`, role: "radio",
      ariaChecked: String(g.id === editingTask.group), textContent: g.name,
      onclick: () => { editingTask.group = g.id; syncTaskGroups(); },
    });
    chip.dataset.g = groupColor(g);
    return chip;
  }));
}
const taskEditorState = () => JSON.stringify([$("ptask-text").value, editingTask.group]);

async function addTask(group, text) {
  await guard(addDoc(ptasksCol, {
    project: projectId, group, text, order: Date.now(), done: false, doneAt: null,
    createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
  }), "add the task");
}
// Enter adds the task and clears the box for the next one (new tasks); Shift+Enter is a new line.
$("ptask-text").addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
  e.preventDefault();
  const text = $("ptask-text").value.trim();
  if (editingTask?.task) { ptaskDialog.close("save"); return; }
  if (!text) return;
  $("ptask-text").value = "";
  editingTask.start = taskEditorState();
  addTask(editingTask.group, text);
});
function cancelTaskEditor() {
  if (!editingTask || taskEditorState() === editingTask.start || confirm("Discard your changes?")) ptaskDialog.close("cancel");
}
ptaskDialog.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !e.isComposing) { e.preventDefault(); cancelTaskEditor(); }
});
ptaskDialog.addEventListener("cancel", (e) => { e.preventDefault(); cancelTaskEditor(); });
$("ptask-delete").addEventListener("click", async () => {
  if (!confirm("Delete this task?")) return;
  const { task } = editingTask;
  ptaskDialog.close();
  await guard(deleteDoc(doc(ptasksCol, task.id)), "delete the task");
});
ptaskDialog.addEventListener("close", async () => {
  if (ptaskDialog.returnValue !== "save" || !editingTask) return;
  ptaskDialog.returnValue = "";
  const { task, group } = editingTask;
  const text = $("ptask-text").value.trim();
  if (!task) {
    if (text) await addTask(group, text);
    return;
  }
  if (!text) return; // an emptied task is kept; Delete removes it
  const changes = { text, updatedAt: serverTimestamp() };
  if (group !== task.group) Object.assign(changes, { group, order: Date.now() });
  await guard(updateDoc(doc(ptasksCol, task.id), changes), "save the task");
});

$("proj-add").addEventListener("click", () => openTaskEditor({}));

// ----- group editor: title and colour -----

const pgroupDialog = $("pgroup-edit");
let editingGroup = null; // {group (null = new), color, start}
$("pgroup-colors").replaceChildren(...Object.entries(GROUP_COLORS).map(([key, label]) => {
  const s = el("button", {
    type: "button", class: "swatch", title: label, ariaLabel: label, role: "radio",
    onclick: () => { editingGroup.color = key; syncGroupSwatches(); },
  });
  s.dataset.g = key;
  return s;
}));
function syncGroupSwatches() {
  for (const s of $("pgroup-colors").children) s.ariaChecked = String(s.dataset.g === editingGroup.color);
}
const groupEditorState = () => JSON.stringify([$("pgroup-name").value, editingGroup.color]);

function openGroupEditor(group) {
  const groups = groupsOf(currentProject());
  // A new group gets the first colour no group is using yet.
  const unused = Object.keys(GROUP_COLORS).find((c) => !groups.some((g) => g.color === c)) ?? "grey";
  editingGroup = { group, color: group ? groupColor(group) : unused };
  pgroupDialog.returnValue = "";
  $("pgroup-title").textContent = group ? "Edit group" : "New group";
  $("pgroup-name").value = group?.name ?? "";
  $("pgroup-delete").hidden = !group || groups.length < 2;
  $("pgroup-save").textContent = group ? "Save" : "Add";
  syncGroupSwatches();
  editingGroup.start = groupEditorState();
  pgroupDialog.showModal();
  if (!group) $("pgroup-name").focus();
}
function cancelGroupEditor() {
  if (!editingGroup || groupEditorState() === editingGroup.start || confirm("Discard your changes?")) pgroupDialog.close("cancel");
}
pgroupDialog.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !e.isComposing) { e.preventDefault(); cancelGroupEditor(); }
});
pgroupDialog.addEventListener("cancel", (e) => { e.preventDefault(); cancelGroupEditor(); });
const saveGroups = (p, groups) => guard(updateDoc(doc(projectsCol, p.id), { groups, updatedAt: serverTimestamp() }), "save the groups");

pgroupDialog.addEventListener("close", async () => {
  if (pgroupDialog.returnValue !== "save" || !editingGroup) return;
  pgroupDialog.returnValue = "";
  const p = currentProject();
  const name = $("pgroup-name").value.trim();
  if (!p || !name) return;
  const { group, color } = editingGroup;
  if (group) {
    await saveGroups(p, groupsOf(p).map((g) => (g.id === group.id ? { ...g, name, color } : g)));
  } else {
    const id = shortId();
    p.groups = [...groupsOf(p), { id, name, color }];
    setGroup(id, "right");
    await saveGroups(p, p.groups);
  }
});

// Deleting a group moves its tasks (to do and finished) into the group next to it.
$("pgroup-delete").addEventListener("click", async () => {
  const p = currentProject();
  const groups = groupsOf(p);
  const { group } = editingGroup;
  const i = groups.findIndex((g) => g.id === group.id);
  const heir = groups[i + 1] ?? groups[i - 1];
  const tasks = projectTasks(p).filter((t) => groupOfTask(t, groups) === group.id);
  const open = tasks.filter((t) => !t.done).length;
  const question = open
    ? `Delete “${group.name}”? Its ${open} task${open === 1 ? "" : "s"} will move to “${heir.name}”.`
    : `Delete “${group.name}”?`;
  if (!confirm(question)) return;
  pgroupDialog.close();
  for (const t of tasks) await guard(updateDoc(doc(ptasksCol, t.id), { group: heir.id, updatedAt: serverTimestamp() }), "move the tasks");
  if (groupId === group.id) setGroup(heir.id);
  await saveGroups(p, groups.filter((g) => g.id !== group.id));
});

// ----- projects: the ▾ menu -----

const projMenu = $("proj-menu");
$("proj-pick").addEventListener("click", () => {
  const p = currentProject();
  $("proj-menu-list").replaceChildren(...sortedProjects().map((x) => {
    const left = projectTasks(x).filter((t) => !t.done).length;
    return el("button", {
      type: "button", class: `menu-item${x.id === p?.id ? " active" : ""}`,
      onclick: () => { projMenu.close(); setProject(x.id); },
    }, el("span", { textContent: x.name || "Untitled project" }), el("small", { textContent: left }));
  }));
  $("proj-menu-finished-n").textContent = p ? finishedTasks(p).length : "";
  projMenu.showModal();
});
// A tap outside the menu (on the backdrop) closes it.
projMenu.addEventListener("click", (e) => { if (e.target === projMenu) projMenu.close(); });
$("proj-menu-finished").addEventListener("click", () => { projMenu.close(); openFinished(); });
$("proj-menu-rename").addEventListener("click", async () => {
  projMenu.close();
  const p = currentProject();
  const name = prompt("Project name", p.name)?.trim();
  if (name && name !== p.name) await guard(updateDoc(doc(projectsCol, p.id), { name, updatedAt: serverTimestamp() }), "rename the project");
});
$("proj-menu-new").addEventListener("click", () => { projMenu.close(); createProject(); });
$("proj-menu-delete").addEventListener("click", async () => {
  projMenu.close();
  const p = currentProject();
  const tasks = projectTasks(p);
  if (!confirm(`Delete “${p.name}” and its ${tasks.length} task${tasks.length === 1 ? "" : "s"}? This can't be undone.`)) return;
  projectId = null;
  for (const t of tasks) await guard(deleteDoc(doc(ptasksCol, t.id)), "delete the tasks");
  await guard(deleteDoc(doc(projectsCol, p.id)), "delete the project");
});
$("proj-create").addEventListener("click", createProject);

async function createProject() {
  const name = prompt("Project name")?.trim();
  if (!name) return;
  const groups = DEFAULT_GROUPS.map(([n, color]) => ({ id: shortId(), name: n, color }));
  const ref = await guard(addDoc(projectsCol, { name, groups, createdAt: serverTimestamp(), updatedAt: serverTimestamp() }), "create the project");
  setProject(ref.id);
}

// ----- finished tasks: one list per project, newest first -----

const doneDialog = $("proj-done");
function openFinished() {
  renderFinished();
  doneDialog.showModal();
}
function renderFinished() {
  const p = currentProject();
  if (!p) return;
  const done = finishedTasks(p);
  const groups = groupsOf(p);
  const today = new Date().setHours(0, 0, 0, 0);
  $("proj-done-sub").textContent = `${done.length} in ${p.name}`;
  const row = (t) => {
    const g = groups.find((x) => x.id === groupOfTask(t, groups));
    const dot = el("i", { title: g?.name ?? "" });
    dot.dataset.g = groupColor(g);
    return el("div", { class: "done-row" }, dot, el("span", { class: "done-text", textContent: t.text }),
      el("button", { type: "button", class: "small", textContent: "Put back", onclick: () => unfinishTask(t.id) }));
  };
  const fresh = done.filter((t) => (toDate(t.doneAt)?.getTime() ?? 0) >= today);
  const older = done.filter((t) => (toDate(t.doneAt)?.getTime() ?? 0) < today);
  $("proj-done-list").replaceChildren(
    ...(fresh.length ? [el("h4", { textContent: "Today" }), ...fresh.map(row)] : []),
    ...(older.length ? [el("h4", { textContent: "Earlier" }), ...older.map(row)] : []),
    ...(done.length ? [] : [el("p", { class: "empty", textContent: "Nothing finished yet." })]));
  $("proj-done-clear").hidden = !done.length;
}
$("proj-done-clear").addEventListener("click", async () => {
  const p = currentProject();
  const done = finishedTasks(p);
  if (!confirm(`Delete all ${done.length} finished task${done.length === 1 ? "" : "s"}?`)) return;
  for (const t of done) await guard(deleteDoc(doc(ptasksCol, t.id)), "clear finished tasks");
});

wideScreen.addEventListener("change", () => renderProjects());

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

// ---------- task reminders (push notifications) ----------
// This device's FCM token is stored in users/{uid}/devices/{deviceId}. A Cloudflare Worker cron
// (worker/src/index.js) reads due tasks every minute and sends a push through FCM;
// sw.js shows it, even with the app closed. Permission is only asked from the Turn on button.
const DEVICE_KEY = "notes.deviceId"; // localStorage is shared by all of Alex's sites
const PUSH_SIG_KEY = "notes.pushSignature"; // token|timeZone last saved, to skip needless writes
const REMINDERS_ON_KEY = "notes.remindersOn"; // uid that turned reminders on here (until Turn off / sign out)
const MESSAGING_URL = "https://www.gstatic.com/firebasejs/13.0.0/firebase-messaging.js";
let remindersUser = null;
let remindersBusy = false;

function deviceRef(user) {
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) localStorage.setItem(DEVICE_KEY, id = crypto.randomUUID());
  return doc(db, "users", user.uid, "devices", id);
}

async function pushSupported() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return false;
  try {
    const { isSupported } = await import(MESSAGING_URL);
    return await isSupported();
  } catch {
    return false;
  }
}

function showReminders(text, { toggle = null, test = false } = {}) {
  $("reminders").hidden = false;
  $("reminders-text").textContent = text;
  $("reminders-toggle").hidden = !toggle;
  if (toggle) $("reminders-toggle").textContent = toggle;
  $("reminders-test").hidden = !test;
}

// Gets this device's push token and saves it (tokens can change, so this runs on every load).
// fresh: drop the old token first (the server found it dead), else Firebase hands back its
// cached copy of it.
async function saveDeviceToken(user, { fresh = false } = {}) {
  const reg = await navigator.serviceWorker.register("sw.js");
  const { getMessaging, getToken, deleteToken } = await import(MESSAGING_URL);
  if (fresh) await deleteToken(getMessaging(app)).catch((err) => console.warn("delete token", err));
  const token = await getToken(getMessaging(app), { serviceWorkerRegistration: reg });
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const sig = `${user.uid}|${token}|${timeZone}`;
  const ref = deviceRef(user);
  if (localStorage.getItem(PUSH_SIG_KEY) === sig && (await getDoc(ref).catch(() => null))?.exists()) return;
  await setDoc(ref, { token, timeZone, userAgent: navigator.userAgent, updatedAt: serverTimestamp() });
  localStorage.setItem(PUSH_SIG_KEY, sig);
  localStorage.setItem(REMINDERS_ON_KEY, user.uid);
}

async function initReminders(user) {
  remindersUser = user;
  $("reminders").hidden = true;
  if (!user || !(await pushSupported()) || remindersUser !== user) return;
  if (Notification.permission === "denied") {
    showReminders("Notifications are blocked for this site. Allow them in the browser's site settings to get task reminders.");
    return;
  }
  const granted = Notification.permission === "granted";
  const exists = granted && (await getDoc(deviceRef(user)).catch(() => null))?.exists();
  if (remindersUser !== user) return;
  // Turned on here but the device doc is gone: the reminder server deletes it when FCM says the
  // token is dead (seen on Android, 2026-11-08). Register again with a new token.
  const heal = granted && !exists && localStorage.getItem(REMINDERS_ON_KEY) === user.uid;
  if (!exists && !heal) {
    showReminders("Get a notification when a task is due.", { toggle: "🔔 Turn on" });
    return;
  }
  showReminders("🔔 Reminders on (this device)", { toggle: "Turn off", test: true });
  saveDeviceToken(user, { fresh: heal }).catch((err) => {
    console.warn("push token", err);
    if (heal) setStatus(`Couldn't renew reminders on this device: ${err.message}`, true);
  });
}

async function turnRemindersOn(user) {
  if ((await Notification.requestPermission()) !== "granted") return initReminders(user);
  showReminders("Turning on…");
  try {
    await saveDeviceToken(user);
    const reg = await navigator.serviceWorker.ready;
    reg.showNotification("Reminders are on", { body: "You'll get one of these when a task is due.", icon: "icons/icon-192.png", tag: "test" })
      .catch((err) => console.warn("test notification", err));
  } catch (err) {
    setStatus(`Couldn't turn on reminders: ${err.message}`, true);
  }
  return initReminders(user);
}

async function turnRemindersOff(user) {
  showReminders("Turning off…");
  try {
    const { getMessaging, deleteToken } = await import(MESSAGING_URL);
    await deleteToken(getMessaging(app)).catch((err) => console.warn("delete token", err));
    localStorage.removeItem(REMINDERS_ON_KEY);
    await deleteDoc(deviceRef(user));
    localStorage.removeItem(PUSH_SIG_KEY);
  } catch (err) {
    setStatus(`Couldn't turn off reminders: ${err.message}`, true);
  }
  return initReminders(user);
}

$("reminders-toggle").addEventListener("click", async () => {
  const user = remindersUser;
  if (!user || remindersBusy) return;
  remindersBusy = true;
  try {
    if ($("reminders-toggle").textContent === "Turn off") await turnRemindersOff(user);
    else await turnRemindersOn(user);
  } finally {
    remindersBusy = false;
  }
});

// Shows a notification straight from this device (checks it can display them, not the push path).
$("reminders-test").addEventListener("click", async () => {
  try {
    const reg = await navigator.serviceWorker.ready;
    await reg.showNotification("Test reminder", { body: "This is what a task reminder looks like.", icon: "icons/icon-192.png", tag: "test" });
  } catch (err) {
    setStatus(`Couldn't show a notification: ${err.message}`, true);
  }
});

// A tapped reminder, when Notes is already open (sw.js posts this instead of reloading the page).
navigator.serviceWorker?.addEventListener("message", (e) => {
  if (e.data?.type === "open" && e.data.hash) location.hash = e.data.hash;
});

onAuthStateChanged(auth, (user) => {
  $("boot").hidden = true;
  initReminders(user);
  unsubs.forEach((u) => u());
  unsubs = [];
  notes = [];
  projects = [];
  ptasks = [];
  renderProjects();
  userData = {};

  $("signin").hidden = Boolean(user);
  $("signout").hidden = !user;
  $("signed-out-msg").hidden = Boolean(user);
  $("app").hidden = !user;
  $("tabs").hidden = !user;
  $("user-email").textContent = user ? user.email : "";
  $("signout").title = user ? `Signed in as ${user.email}` : "";

  if (!user) {
    userRef = notesCol = projectsCol = ptasksCol = null;
    scratch.value = "";
    updateScratchClear();
    setStatus("");
    return;
  }

  userRef = doc(db, "users", user.uid);
  notesCol = collection(userRef, "notes");
  projectsCol = collection(userRef, "projects");
  ptasksCol = collection(userRef, "ptasks");
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

  const projectsChanged = () => {
    renderProjects();
    if (doneDialog.open) renderFinished();
  };
  unsubs.push(onSnapshot(projectsCol, { includeMetadataChanges: true }, (snap) => {
    projects = snap.docs.map((d) => ({ id: d.id, ...d.data({ serverTimestamps: "estimate" }) }));
    projectsChanged();
    updateSync("projects", snap.metadata);
  }, (err) => setStatus(loadError(user, err, "load projects"), true)));

  unsubs.push(onSnapshot(ptasksCol, { includeMetadataChanges: true }, (snap) => {
    ptasks = snap.docs.map((d) => ({ id: d.id, ...d.data({ serverTimestamps: "estimate" }) }));
    projectsChanged();
    updateSync("ptasks", snap.metadata);
  }, (err) => setStatus(loadError(user, err, "load project tasks"), true)));
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
  // A signed-out device shouldn't keep getting this account's reminders.
  if (remindersUser) {
    const removed = deleteDoc(deviceRef(remindersUser)).catch(() => {});
    await Promise.race([removed, new Promise((r) => setTimeout(r, 3000))]); // offline: don't hang
  }
  localStorage.removeItem(PUSH_SIG_KEY);
  localStorage.removeItem(REMINDERS_ON_KEY);
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
  const keyboard = Boolean(typing) && window.innerHeight < fullHeight * 0.8;
  // Keyboard closed (e.g. with Android's back gesture) while zoomed in on the scratch pad:
  // let go of the pad, so it turns read-only and sideways swipes pan instead of moving the caret.
  if (!keyboard && document.body.classList.contains("keyboard") && document.activeElement === scratch && zoomed()) {
    scratch.blur();
  }
  document.body.classList.toggle("keyboard", keyboard);
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
