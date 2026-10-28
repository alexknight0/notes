// Single-note app: Google sign-in (Firebase Auth) + one note per user in Firestore.
// The note is stored at notes/{uid} as { text, updatedAt }.
// firestore.rules restricts each account to its own document.
import { initializeApp } from "https://www.gstatic.com/firebasejs/13.0.0/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut,
} from "https://www.gstatic.com/firebasejs/13.0.0/firebase-auth.js";
import {
  getFirestore, doc, onSnapshot, setDoc, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/13.0.0/firebase-firestore.js";

// Public web-app config (not a secret; access is controlled by firestore.rules).
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyBf8KKXDVMi-iIbRfI64NgUtK1kM0QdmSw",
  authDomain: "notes-e2b6c3.firebaseapp.com",
  projectId: "notes-e2b6c3",
  appId: "1:901046426288:web:a4206278ac235fcb74b975",
};

const SAVE_DELAY_MS = 800;

const app = initializeApp(FIREBASE_CONFIG);
const auth = getAuth(app);
const db = getFirestore(app);

const $ = (id) => document.getElementById(id);
const note = $("note");
const status = $("status");

let unsubscribe = null;
let saveTimer = null;
let noteRef = null;

function setStatus(text, isError = false) {
  status.textContent = text;
  status.classList.toggle("error", isError);
}

async function save() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!noteRef) return;
  try {
    await setDoc(noteRef, { text: note.value, updatedAt: serverTimestamp() });
    setStatus("Saved");
  } catch (err) {
    setStatus(`Couldn't save: ${err.message}`, true);
  }
}

note.addEventListener("input", () => {
  setStatus("Editing…");
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, SAVE_DELAY_MS);
});

// Save straight away if the tab is hidden/closed with unsaved edits.
document.addEventListener("visibilitychange", () => { if (document.hidden && saveTimer) save(); });

onAuthStateChanged(auth, (user) => {
  if (unsubscribe) unsubscribe();
  unsubscribe = null;
  noteRef = null;

  $("signin").hidden = Boolean(user);
  $("signout").hidden = !user;
  $("signed-out-msg").hidden = Boolean(user);
  note.hidden = !user;
  $("user-email").textContent = user ? user.email : "";

  if (!user) {
    note.value = "";
    setStatus("");
    return;
  }

  noteRef = doc(db, "notes", user.uid);
  setStatus("Loading…");
  // Live updates, so edits from another device show up here.
  unsubscribe = onSnapshot(
    noteRef,
    (snap) => {
      // Don't clobber what the user is typing; local pending writes are our own.
      if (saveTimer || snap.metadata.hasPendingWrites) return;
      note.value = snap.data()?.text ?? "";
      setStatus("Saved");
    },
    (err) => setStatus(`Couldn't load: ${err.message}`, true),
  );
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
  if (saveTimer) await save();
  signOut(auth);
});
