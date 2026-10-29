// Fact search: fuzzy keyword matching (Fuse.js) combined with on-device semantic
// similarity (all-MiniLM-L6-v2 sentence embeddings via transformers.js).
// The model (~23 MB) is downloaded on first use and cached by the browser.
import Fuse from "https://cdn.jsdelivr.net/npm/fuse.js@7.5.0/dist/fuse.mjs";

const TRANSFORMERS_URL = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2";
export const MODEL_ID = "Xenova/all-MiniLM-L6-v2";

// Cosine similarities below this are treated as unrelated; scores are scaled so
// that SEMANTIC_FLOOR -> 0 and SEMANTIC_FLOOR + SEMANTIC_RANGE -> 1.
const SEMANTIC_FLOOR = 0.2;
const SEMANTIC_RANGE = 0.45;
const MIN_SCORE = 0.25;

let extractorPromise = null;

// Starts loading the model (once). onProgress gets 0..100 while downloading.
export function loadModel(onProgress = () => {}) {
  if (!extractorPromise) {
    const files = {};
    extractorPromise = import(TRANSFORMERS_URL)
      .then(({ pipeline }) => pipeline("feature-extraction", MODEL_ID, {
        dtype: "q8",
        progress_callback: (p) => {
          if (p.status !== "progress" || !p.total) return;
          files[p.file] = [p.loaded, p.total];
          const [loaded, total] = Object.values(files).reduce(([a, b], [c, d]) => [a + c, b + d], [0, 0]);
          onProgress(Math.round((loaded / total) * 100));
        },
      }))
      .catch((err) => { extractorPromise = null; throw err; });
  }
  return extractorPromise;
}

export function modelReady() {
  return extractorPromise !== null;
}

// Returns a normalised 384-dim embedding as a plain array (rounded to keep Firestore docs small).
export async function embed(text) {
  const extractor = await loadModel();
  const out = await extractor(text, { pooling: "mean", normalize: true });
  return Array.from(out.data, (x) => Math.round(x * 1e4) / 1e4);
}

function cosine(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot; // both vectors are normalised
}

// notes: [{id, text, embedding?}]. queryEmbedding may be null (model not loaded yet).
// Returns notes sorted by relevance, filtered to plausible matches.
export function rank(notes, query, queryEmbedding) {
  const fuse = new Fuse(notes, { keys: ["text"], includeScore: true, ignoreLocation: true, threshold: 0.45 });
  const fuzzy = new Map(fuse.search(query).map((r) => [r.item.id, 1 - r.score]));
  return notes
    .map((note) => {
      const f = fuzzy.get(note.id) ?? 0;
      let s = 0;
      if (queryEmbedding && note.embedding) {
        s = Math.min(1, Math.max(0, (cosine(queryEmbedding, note.embedding) - SEMANTIC_FLOOR) / SEMANTIC_RANGE));
      }
      return { note, score: Math.max(f, s) };
    })
    .filter((r) => r.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .map((r) => r.note);
}
