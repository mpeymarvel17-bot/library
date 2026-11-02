'use strict';

const fs = require('fs');
const { initializeApp, cert, getApps, applicationDefault } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

/**
 * Lapisan data sederhana di atas Firestore.
 *
 * Kredensial dibaca dari environment variable:
 *   - FIREBASE_SERVICE_ACCOUNT       : isi JSON service account (dipakai di Vercel)
 *   - FIREBASE_SERVICE_ACCOUNT_PATH  : path file JSON service account
 *   - GOOGLE_APPLICATION_CREDENTIALS : default credential Google
 *
 * Jika tidak ada kredensial (mis. `npm start` di laptop tanpa setup Firebase),
 * data disimpan di memori supaya aplikasi tetap bisa dicoba. Data memori hilang
 * saat proses berhenti dan tidak boleh dipakai untuk produksi.
 */

function buildCredential() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (raw) {
    try {
      return cert(JSON.parse(raw));
    } catch (error) {
      throw new Error('FIREBASE_SERVICE_ACCOUNT bukan JSON yang valid: ' + error.message);
    }
  }

  const filePath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  if (filePath) {
    if (!fs.existsSync(filePath)) {
      throw new Error('File service account tidak ditemukan: ' + filePath);
    }
    return cert(JSON.parse(fs.readFileSync(filePath, 'utf8')));
  }

  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    return applicationDefault();
  }

  return null;
}

let firestore = null;
try {
  const credential = buildCredential();
  if (credential) {
    if (!getApps().length) {
      initializeApp({ credential });
    }
    firestore = getFirestore();
  }
} catch (error) {
  console.error('[db] Gagal menyiapkan Firestore, memakai penyimpanan sementara:', error.message);
}

const mode = firestore ? 'firestore' : 'memory';

// Di server produksi jangan diam-diam memakai data sementara: data akan hilang.
function assertAvailable() {
  if (!firestore && process.env.VERCEL) {
    throw new Error('Firebase belum dikonfigurasi. Set environment variable FIREBASE_SERVICE_ACCOUNT di Vercel.');
  }
}

// ---------------------------------------------------------------------------
// Penyimpanan sementara (mode lokal tanpa kredensial)
// ---------------------------------------------------------------------------

const memory = { books: new Map(), members: new Map(), loans: new Map() };
let memorySeq = 0;
let memoryLock = Promise.resolve();

function clone(value) {
  return value === null || value === undefined ? value : structuredClone(value);
}

function withoutId(data) {
  const payload = { ...data };
  delete payload.id;
  return payload;
}

const memoryTransaction = {
  async get(collection, id) {
    const found = memory[collection].get(id);
    return found ? clone(found) : null;
  },
  async set(collection, id, data) {
    memory[collection].set(id, clone({ ...withoutId(data), id }));
  },
  async add(collection, data) {
    const id = 'mem-' + ++memorySeq;
    memory[collection].set(id, clone({ ...withoutId(data), id }));
    return id;
  }
};

// ---------------------------------------------------------------------------
// API publik
// ---------------------------------------------------------------------------

async function list(collection) {
  assertAvailable();
  if (firestore) {
    const snapshot = await firestore.collection(collection).get();
    return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  }
  return [...memory[collection].values()].map(clone);
}

async function get(collection, id) {
  assertAvailable();
  if (firestore) {
    const snapshot = await firestore.collection(collection).doc(String(id)).get();
    return snapshot.exists ? { id: snapshot.id, ...snapshot.data() } : null;
  }
  const found = memory[collection].get(String(id));
  return found ? clone(found) : null;
}

async function add(collection, data) {
  assertAvailable();
  if (firestore) {
    const ref = await firestore.collection(collection).add(withoutId(data));
    return ref.id;
  }
  return memoryTransaction.add(collection, data);
}

async function update(collection, id, data) {
  assertAvailable();
  if (firestore) {
    await firestore.collection(collection).doc(String(id)).set(withoutId(data), { merge: true });
    return;
  }
  const existing = memory[collection].get(String(id));
  memory[collection].set(String(id), clone({ ...(existing || { id: String(id) }), ...withoutId(data), id: String(id) }));
}

async function remove(collection, id) {
  assertAvailable();
  if (firestore) {
    await firestore.collection(collection).doc(String(id)).delete();
    return;
  }
  memory[collection].delete(String(id));
}

/**
 * Menjalankan operasi baca-tulis secara atomik. Handler menerima objek
 * transaksi dengan method get/set/add/delete yang semuanya async.
 */
async function runTransaction(handler) {
  assertAvailable();
  if (firestore) {
    return firestore.runTransaction(async (tx) => handler({
      get: async (collection, id) => {
        const snapshot = await tx.get(firestore.collection(collection).doc(String(id)));
        return snapshot.exists ? { id: snapshot.id, ...snapshot.data() } : null;
      },
      set: async (collection, id, data) => {
        tx.set(firestore.collection(collection).doc(String(id)), withoutId(data));
      },
      add: async (collection, data) => {
        const ref = firestore.collection(collection).doc();
        tx.set(ref, withoutId(data));
        return ref.id;
      },
      delete: async (collection, id) => {
        tx.delete(firestore.collection(collection).doc(String(id)));
      }
    }));
  }

  const run = memoryLock.then(() => handler(memoryTransaction));
  memoryLock = run.then(() => undefined, () => undefined);
  return run;
}

module.exports = { mode, list, get, add, update, remove, runTransaction };
