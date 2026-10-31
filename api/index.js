const express = require('express');
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const path = require('path');

// Inisialisasi Firebase Admin
// Pastikan Anda menyimpan service account key di Environment Variable Vercel bernama FIREBASE_SERVICE_ACCOUNT
if (!getApps().length) {
  let serviceAccount;
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  } else {
    // Untuk development lokal jika menggunakan file json (opsional)
    // serviceAccount = require('../serviceAccountKey.json');
  }

  if (serviceAccount) {
    initializeApp({
      credential: cert(serviceAccount)
    });
  } else {
    // Fallback jika dijalankan tanpa kredensial (akan error saat query ke firestore, pastikan env terisi)
    initializeApp();
  }
}

const db = getFirestore();
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve file statis dari folder public
app.use(express.static(path.join(__dirname, '../public')));

// API: Ambil semua buku
app.get('/api/books', async (req, res) => {
  try {
    const snapshot = await db.collection('books').orderBy('createdAt', 'desc').get();
    const books = [];
    snapshot.forEach(doc => {
      books.push({ id: doc.id, ...doc.data() });
    });
    res.json({ success: true, data: books });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// API: Tambah buku baru
app.post('/api/books', async (req, res) => {
  try {
    const { title, author, year } = req.body;
    if (!title || !author) {
      return res.status(400).json({ success: false, message: 'Judul dan Penulis wajib diisi!' });
    }

    const newBook = {
      title,
      author,
      year: year || '-',
      createdAt: new Date().toISOString()
    };

    const docRef = await db.collection('books').add(newBook);
    res.status(201).json({ success: true, message: 'Buku berhasil ditambahkan', id: docRef.id });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// API: Hapus buku
app.delete('/api/books/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await db.collection('books').doc(id).delete();
    res.json({ success: true, message: 'Buku berhasil dihapus' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = app;