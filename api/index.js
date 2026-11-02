'use strict';

const express = require('express');
const path = require('path');
const store = require('./db');

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Sebagian platform (mis. rewrite Vercel) bisa mengirim request sebagai
// /api/index.js/books. Normalisasi agar router Express tetap cocok.
app.use((req, res, next) => {
  const prefix = '/api/index.js';
  if (req.url === prefix || req.url.startsWith(prefix + '/') || req.url.startsWith(prefix + '?')) {
    req.url = '/api' + req.url.slice(prefix.length);
  }
  next();
});

// Serve file statis dari folder public (dipakai saat development lokal)
app.use(express.static(path.join(__dirname, '../public')));

// ---------------------------------------------------------------------------
// Konfigurasi aturan perpustakaan
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULTS = {
  loanDays: Number(process.env.DEFAULT_LOAN_DAYS || 7),
  maxLoanDays: Number(process.env.MAX_LOAN_DAYS || 30),
  finePerDay: Number(process.env.FINE_PER_DAY || 1000)
};
const MEMBER_TYPES = ['Siswa', 'Mahasiswa', 'Umum'];

// ---------------------------------------------------------------------------
// Utilitas
// ---------------------------------------------------------------------------

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

function dayNumber(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS);
}

function lateDays(dueAt, at = new Date()) {
  const due = dayNumber(dueAt);
  const now = dayNumber(at);
  if (due === null || now === null) return 0;
  return Math.max(0, now - due);
}

function parseStock(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const stock = Number(value);
  if (!Number.isInteger(stock) || stock < 1) {
    throw httpError(400, 'Stok harus bilangan bulat minimal 1.');
  }
  return stock;
}

function parseYear(value, fallback = null) {
  if (value === undefined) return fallback;
  if (value === null || value === '') return null;
  const year = Number(value);
  if (!Number.isInteger(year) || year < 1000 || year > 2100) {
    throw httpError(400, 'Tahun terbit harus di antara 1000 dan 2100.');
  }
  return year;
}

function requireText(value, label, maxLength = 200) {
  const text = String(value === undefined || value === null ? '' : value).trim();
  if (!text) throw httpError(400, label + ' wajib diisi.');
  if (text.length > maxLength) throw httpError(400, label + ' maksimal ' + maxLength + ' karakter.');
  return text;
}

function optionalText(value, maxLength = 200) {
  if (value === undefined || value === null) return '';
  const text = String(value).trim();
  if (text.length > maxLength) throw httpError(400, 'Teks maksimal ' + maxLength + ' karakter.');
  return text;
}

function enrichLoan(loan, now = new Date()) {
  const isActive = loan.status === 'borrowed';
  const overdueDays = isActive ? lateDays(loan.dueAt, now) : Number(loan.lateDays || 0);
  const fine = isActive ? overdueDays * DEFAULTS.finePerDay : Number(loan.fine || 0);
  return { ...loan, lateDays: overdueDays, fine, isOverdue: isActive && overdueDays > 0 };
}

function nextMemberCode(members) {
  const highest = members.reduce((max, member) => {
    const match = /^AGT-(\d+)$/.exec(member.code || '');
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);
  return 'AGT-' + String(highest + 1).padStart(4, '0');
}

async function activeLoanCount(field, id) {
  const loans = await store.list('loans');
  return loans.filter((loan) => loan[field + 'Id'] === id && loan.status === 'borrowed').length;
}

// ---------------------------------------------------------------------------
// Meta
// ---------------------------------------------------------------------------

app.get('/api/health', (req, res) => {
  res.json({ success: true, storage: store.mode, settings: DEFAULTS });
});

// ---------------------------------------------------------------------------
// Manajemen Buku (Katalog)
// ---------------------------------------------------------------------------

app.get('/api/books', wrap(async (req, res) => {
  const keyword = optionalText(req.query.q).toLowerCase();
  const category = optionalText(req.query.category).toLowerCase();
  const availability = optionalText(req.query.availability).toLowerCase();

  let books = await store.list('books');

  if (keyword) {
    books = books.filter((book) => [book.title, book.author, book.category]
      .some((field) => String(field || '').toLowerCase().includes(keyword)));
  }
  if (category) {
    books = books.filter((book) => String(book.category || '').toLowerCase() === category);
  }
  if (availability === 'available') {
    books = books.filter((book) => Number(book.available || 0) > 0);
  } else if (availability === 'empty') {
    books = books.filter((book) => Number(book.available || 0) <= 0);
  }

  books.sort((a, b) => String(a.title || '').localeCompare(String(b.title || ''), 'id'));
  res.json({ success: true, data: books });
}));

app.get('/api/books/categories', wrap(async (req, res) => {
  const books = await store.list('books');
  const categories = [...new Set(books.map((book) => String(book.category || '').trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'id'));
  res.json({ success: true, data: categories });
}));

app.get('/api/books/:id', wrap(async (req, res) => {
  const book = await store.get('books', req.params.id);
  if (!book) throw httpError(404, 'Buku tidak ditemukan.');
  res.json({ success: true, data: book });
}));

app.post('/api/books', wrap(async (req, res) => {
  const now = new Date().toISOString();
  const stock = parseStock(req.body.stock, 1);

  const book = {
    title: requireText(req.body.title, 'Judul'),
    author: requireText(req.body.author, 'Penulis'),
    year: parseYear(req.body.year),
    category: optionalText(req.body.category, 60) || 'Umum',
    stock,
    available: stock,
    createdAt: now,
    updatedAt: now
  };

  const id = await store.add('books', book);
  res.status(201).json({ success: true, message: 'Buku berhasil ditambahkan.', id, data: { id, ...book } });
}));

app.put('/api/books/:id', wrap(async (req, res) => {
  const existing = await store.get('books', req.params.id);
  if (!existing) throw httpError(404, 'Buku tidak ditemukan.');

  const borrowed = Number(existing.stock || 0) - Number(existing.available || 0);
  const stock = parseStock(req.body.stock, Number(existing.stock || 1));
  if (stock < borrowed) {
    throw httpError(400, 'Stok tidak boleh lebih kecil dari ' + borrowed + ' karena buku sedang dipinjam.');
  }

  const book = {
    ...existing,
    title: req.body.title === undefined ? existing.title : requireText(req.body.title, 'Judul'),
    author: req.body.author === undefined ? existing.author : requireText(req.body.author, 'Penulis'),
    year: parseYear(req.body.year, existing.year === undefined ? null : existing.year),
    category: req.body.category === undefined
      ? (existing.category || 'Umum')
      : (optionalText(req.body.category, 60) || 'Umum'),
    stock,
    available: stock - borrowed,
    updatedAt: new Date().toISOString()
  };

  await store.update('books', req.params.id, book);
  res.json({ success: true, message: 'Buku berhasil diperbarui.', data: book });
}));

app.delete('/api/books/:id', wrap(async (req, res) => {
  const book = await store.get('books', req.params.id);
  if (!book) throw httpError(404, 'Buku tidak ditemukan.');

  if (await activeLoanCount('book', req.params.id)) {
    throw httpError(409, 'Buku masih dipinjam. Catat pengembalian terlebih dahulu.');
  }

  await store.remove('books', req.params.id);
  res.json({ success: true, message: 'Buku berhasil dihapus.' });
}));

// ---------------------------------------------------------------------------
// Manajemen Anggota
// ---------------------------------------------------------------------------

app.get('/api/members', wrap(async (req, res) => {
  const keyword = optionalText(req.query.q).toLowerCase();
  const type = optionalText(req.query.type).toLowerCase();

  let members = await store.list('members');

  if (keyword) {
    members = members.filter((member) => [member.name, member.code, member.email, member.phone]
      .some((field) => String(field || '').toLowerCase().includes(keyword)));
  }
  if (type) {
    members = members.filter((member) => String(member.type || '').toLowerCase() === type);
  }

  members.sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'id'));
  res.json({ success: true, data: members, memberTypes: MEMBER_TYPES });
}));

app.get('/api/members/:id', wrap(async (req, res) => {
  const member = await store.get('members', req.params.id);
  if (!member) throw httpError(404, 'Anggota tidak ditemukan.');
  res.json({ success: true, data: member });
}));

app.post('/api/members', wrap(async (req, res) => {
  const name = requireText(req.body.name, 'Nama anggota');
  const type = optionalText(req.body.type, 30) || 'Umum';
  if (!MEMBER_TYPES.includes(type)) {
    throw httpError(400, 'Tipe anggota harus salah satu dari: ' + MEMBER_TYPES.join(', ') + '.');
  }

  const members = await store.list('members');
  const code = optionalText(req.body.code, 40) || nextMemberCode(members);
  if (members.some((member) => String(member.code || '').toLowerCase() === code.toLowerCase())) {
    throw httpError(409, 'Nomor anggota "' + code + '" sudah dipakai.');
  }

  const now = new Date().toISOString();
  const member = {
    name,
    code,
    type,
    email: optionalText(req.body.email, 120),
    phone: optionalText(req.body.phone, 30),
    address: optionalText(req.body.address, 300),
    createdAt: now,
    updatedAt: now
  };

  const id = await store.add('members', member);
  res.status(201).json({ success: true, message: 'Anggota berhasil didaftarkan.', id, data: { id, ...member } });
}));

app.put('/api/members/:id', wrap(async (req, res) => {
  const existing = await store.get('members', req.params.id);
  if (!existing) throw httpError(404, 'Anggota tidak ditemukan.');

  const type = req.body.type === undefined ? existing.type : (optionalText(req.body.type, 30) || existing.type);
  if (!MEMBER_TYPES.includes(type)) {
    throw httpError(400, 'Tipe anggota harus salah satu dari: ' + MEMBER_TYPES.join(', ') + '.');
  }

  const code = req.body.code === undefined
    ? (existing.code || '')
    : (optionalText(req.body.code, 40) || existing.code || '');

  if (code && code !== existing.code) {
    const members = await store.list('members');
    if (members.some((member) => member.id !== req.params.id && String(member.code || '').toLowerCase() === code.toLowerCase())) {
      throw httpError(409, 'Nomor anggota "' + code + '" sudah dipakai.');
    }
  }

  const member = {
    ...existing,
    name: req.body.name === undefined ? existing.name : requireText(req.body.name, 'Nama anggota'),
    code,
    type,
    email: req.body.email === undefined ? (existing.email || '') : optionalText(req.body.email, 120),
    phone: req.body.phone === undefined ? (existing.phone || '') : optionalText(req.body.phone, 30),
    address: req.body.address === undefined ? (existing.address || '') : optionalText(req.body.address, 300),
    updatedAt: new Date().toISOString()
  };

  await store.update('members', req.params.id, member);
  res.json({ success: true, message: 'Data anggota berhasil diperbarui.', data: member });
}));

app.delete('/api/members/:id', wrap(async (req, res) => {
  const member = await store.get('members', req.params.id);
  if (!member) throw httpError(404, 'Anggota tidak ditemukan.');

  if (await activeLoanCount('member', req.params.id)) {
    throw httpError(409, 'Anggota masih memiliki peminjaman aktif. Catat pengembalian terlebih dahulu.');
  }

  await store.remove('members', req.params.id);
  res.json({ success: true, message: 'Anggota berhasil dihapus.' });
}));

// ---------------------------------------------------------------------------
// Peminjaman & Pengembalian
// ---------------------------------------------------------------------------

app.get('/api/loans', wrap(async (req, res) => {
  const keyword = optionalText(req.query.q).toLowerCase();
  const status = optionalText(req.query.status).toLowerCase();

  let loans = (await store.list('loans')).map((loan) => enrichLoan(loan));

  if (keyword) {
    loans = loans.filter((loan) => [loan.bookTitle, loan.memberName, loan.memberCode]
      .some((field) => String(field || '').toLowerCase().includes(keyword)));
  }
  if (status === 'borrowed' || status === 'returned') {
    loans = loans.filter((loan) => loan.status === status);
  } else if (status === 'overdue') {
    loans = loans.filter((loan) => loan.isOverdue);
  }

  loans.sort((a, b) => String(b.borrowedAt || '').localeCompare(String(a.borrowedAt || '')));
  res.json({ success: true, data: loans, settings: DEFAULTS });
}));

app.post('/api/loans', wrap(async (req, res) => {
  const bookId = optionalText(req.body.bookId, 120);
  const memberId = optionalText(req.body.memberId, 120);
  if (!bookId) throw httpError(400, 'Buku wajib dipilih.');
  if (!memberId) throw httpError(400, 'Anggota wajib dipilih.');

  let loanDays = DEFAULTS.loanDays;
  if (req.body.days !== undefined && req.body.days !== '') {
    loanDays = Number(req.body.days);
    if (!Number.isInteger(loanDays) || loanDays < 1 || loanDays > DEFAULTS.maxLoanDays) {
      throw httpError(400, 'Lama pinjam harus 1 sampai ' + DEFAULTS.maxLoanDays + ' hari.');
    }
  }

  const now = new Date();
  const dueAt = new Date(now.getTime() + loanDays * DAY_MS);
  const borrowedAt = now.toISOString();

  const result = await store.runTransaction(async (tx) => {
    const book = await tx.get('books', bookId);
    if (!book) throw httpError(404, 'Buku tidak ditemukan.');

    const member = await tx.get('members', memberId);
    if (!member) throw httpError(404, 'Anggota tidak ditemukan.');

    if (Number(book.available || 0) <= 0) {
      throw httpError(409, 'Stok buku "' + book.title + '" sedang tidak tersedia.');
    }

    await tx.set('books', bookId, {
      ...book,
      available: Number(book.available || 0) - 1,
      updatedAt: borrowedAt
    });

    const loan = {
      bookId,
      bookTitle: book.title,
      bookAuthor: book.author,
      memberId,
      memberName: member.name,
      memberCode: member.code,
      borrowedAt,
      dueAt: dueAt.toISOString(),
      loanDays,
      returnedAt: null,
      status: 'borrowed',
      lateDays: 0,
      fine: 0
    };

    const id = await tx.add('loans', loan);
    return { id, ...loan };
  });

  res.status(201).json({
    success: true,
    message: 'Peminjaman dicatat. Jatuh tempo ' + dueAt.toLocaleDateString('id-ID') + '.',
    data: enrichLoan(result)
  });
}));

app.post('/api/loans/:id/return', wrap(async (req, res) => {
  const now = new Date();
  const returnedAt = now.toISOString();

  const result = await store.runTransaction(async (tx) => {
    const loan = await tx.get('loans', req.params.id);
    if (!loan) throw httpError(404, 'Transaksi peminjaman tidak ditemukan.');
    if (loan.status !== 'borrowed') {
      throw httpError(409, 'Transaksi ini sudah dikembalikan pada ' +
        new Date(loan.returnedAt).toLocaleDateString('id-ID') + '.');
    }

    const days = lateDays(loan.dueAt, now);
    const updated = { ...loan, status: 'returned', returnedAt, lateDays: days, fine: days * DEFAULTS.finePerDay };
    await tx.set('loans', req.params.id, updated);

    const book = await tx.get('books', loan.bookId);
    if (book) {
      await tx.set('books', loan.bookId, {
        ...book,
        available: Math.min(Number(book.stock || 0), Number(book.available || 0) + 1),
        updatedAt: returnedAt
      });
    }

    return updated;
  });

  const message = result.fine > 0
    ? 'Buku dikembalikan terlambat ' + result.lateDays + ' hari. Denda Rp ' + result.fine.toLocaleString('id-ID') + '.'
    : 'Buku dikembalikan tepat waktu. Tidak ada denda.';

  res.json({ success: true, message, data: enrichLoan(result) });
}));

// ---------------------------------------------------------------------------
// Laporan
// ---------------------------------------------------------------------------

app.get('/api/reports', wrap(async (req, res) => {
  const now = new Date();
  const [books, members, rawLoans] = await Promise.all([
    store.list('books'),
    store.list('members'),
    store.list('loans')
  ]);

  const loans = rawLoans.map((loan) => enrichLoan(loan, now));
  const active = loans.filter((loan) => loan.status === 'borrowed');
  const returned = loans.filter((loan) => loan.status === 'returned');
  const overdue = active.filter((loan) => loan.isOverdue);

  const totalCopies = books.reduce((sum, book) => sum + Number(book.stock || 0), 0);
  const availableCopies = books.reduce((sum, book) => sum + Number(book.available || 0), 0);

  // Buku terpopuler berdasarkan jumlah transaksi peminjaman
  const popularity = new Map();
  for (const loan of loans) {
    const entry = popularity.get(loan.bookId) || {
      bookId: loan.bookId,
      title: loan.bookTitle,
      author: loan.bookAuthor,
      totalLoans: 0,
      activeLoans: 0
    };
    entry.totalLoans += 1;
    if (loan.status === 'borrowed') entry.activeLoans += 1;
    popularity.set(loan.bookId, entry);
  }
  const topBooks = [...popularity.values()]
    .sort((a, b) => b.totalLoans - a.totalLoans || String(a.title).localeCompare(String(b.title), 'id'))
    .slice(0, 10);

  // Rekap denda: sudah dibayar (transaksi selesai) dan masih berjalan (terlambat)
  const fines = loans
    .filter((loan) => loan.fine > 0)
    .map((loan) => ({
      loanId: loan.id,
      bookTitle: loan.bookTitle,
      memberName: loan.memberName,
      dueAt: loan.dueAt,
      returnedAt: loan.returnedAt,
      lateDays: loan.lateDays,
      fine: loan.fine,
      settled: loan.status === 'returned'
    }))
    .sort((a, b) => b.fine - a.fine);

  const collectedFines = returned.reduce((sum, loan) => sum + Number(loan.fine || 0), 0);
  const outstandingFines = overdue.reduce((sum, loan) => sum + Number(loan.fine || 0), 0);

  // Rekap 6 bulan terakhir
  const monthly = [];
  for (let offset = 5; offset >= 0; offset -= 1) {
    const cursor = new Date(now.getFullYear(), now.getMonth() - offset, 1);
    const prefix = cursor.getFullYear() + '-' + String(cursor.getMonth() + 1).padStart(2, '0');
    const monthReturns = returned.filter((loan) => String(loan.returnedAt || '').startsWith(prefix));
    monthly.push({
      month: prefix,
      label: cursor.toLocaleDateString('id-ID', { month: 'long', year: 'numeric' }),
      loans: loans.filter((loan) => String(loan.borrowedAt || '').startsWith(prefix)).length,
      returns: monthReturns.length,
      fines: monthReturns.reduce((sum, loan) => sum + Number(loan.fine || 0), 0)
    });
  }

  res.json({
    success: true,
    settings: DEFAULTS,
    data: {
      summary: {
        totalTitles: books.length,
        totalCopies,
        availableCopies,
        borrowedCopies: totalCopies - availableCopies,
        totalMembers: members.length,
        activeLoans: active.length,
        returnedLoans: returned.length,
        overdueLoans: overdue.length,
        totalFines: collectedFines + outstandingFines,
        collectedFines,
        outstandingFines
      },
      topBooks,
      fines,
      monthly
    }
  });
}));

// ---------------------------------------------------------------------------
// Penanganan error & server lokal
// ---------------------------------------------------------------------------

app.use('/api', (req, res) => {
  res.status(404).json({ success: false, message: 'Endpoint tidak ditemukan.' });
});

app.use((error, req, res, next) => { // eslint-disable-line no-unused-vars
  const status = error.status || 500;
  if (status >= 500) console.error('[api]', error);
  res.status(status).json({ success: false, message: error.message || 'Terjadi kesalahan pada server.' });
});

const port = Number(process.env.PORT || 3000);
if (require.main === module) {
  app.listen(port, () => {
    console.log('Perpustakaan siap di http://localhost:' + port + ' (storage: ' + store.mode + ')');
  });
}

module.exports = app;
