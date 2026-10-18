# Changelog

## 0.2.1 — Perbaikan dari uji file nyata (video promosi 9:16, 60 detik)

- Durasi otomatis tidak lagi gagal pada pemutar yang menulis ulang nilai yang sama setiap frame (mis. `textContent`
  identik): mutasi DOM tanpa perubahan nyata diabaikan.
- **Hanya area animasi:** panggung animasi (mis. bingkai 9:16) dideteksi dan dirender sendiri, tanpa latar halaman
  maupun tombol pemutar di luar panggung (bisa dimatikan).
- Render ±10× lebih cepat: adegan yang tidak terlihat (opacity 0/display none) tidak ikut diproses.
- Audio Web Audio direkam paralel dengan render frame, sehingga total waktu ≈ durasi animasi.

## 0.2.0 — Konversi langsung

- **Konversi langsung (default):** unggah → konversi → unduh tanpa dialog izin rekam layar. Animasi dirender frame demi
  frame di sandbox tersembunyi dengan jam virtual, lalu di-encode di Web Worker.
- **Durasi otomatis:** mengikuti durasi animasi (deklarasi `h2m:duration`, GSAP/anime.js/Lottie/CSS, atau saat halaman
  berhenti berubah). Animasi yang berulang terus memakai durasi yang diisi, dengan pemberitahuan.
- **Klik otomatis tombol “Putar/Play”** untuk animasi yang menunggu klik.
- **Audio tanpa izin:** `<audio>/<video>` di-mix offline; Web Audio direkam real-time di dalam sandbox.
- **Saran resolusi** vertikal (1080×1920) / persegi saat konten terdeteksi berbentuk demikian.
- Rekam layar tetap tersedia sebagai metode cadangan; durasinya juga bisa mengikuti deteksi preview.

## 0.1.0 — MVP

- Website statis Astro + TypeScript + Tailwind CSS, siap deploy ke Vercel (`vercel.json` dengan header keamanan).
- Import `.html`/`.zip` dengan validasi ukuran, jumlah file, path traversal, dan ZIP bomb; ekstraksi di Web Worker.
- Preview di iframe sandbox (`allow-scripts`, origin opaque); HTML pengguna hanya di-parse di dalam sandbox; aset ZIP
  dipetakan ke `blob:` URL (CSS, import modul ES, `fetch`, XHR, `src`, `Audio`).
- Perekaman tab/jendela dengan izin pengguna: mode “Tab ini” (Region Capture) dan jendela preview terpisah; verifikasi
  tab via Capture Handle; durasi otomatis, stop, batal.
- Ekspor MP4 (H.264/AAC, fallback VP9/AV1 berlabel), MP3 (CBR 192 kbps), WebM via Mediabunny di Web Worker; encoder
  AAC/MP3 WASM lazy-loaded.
- Validasi hasil (signature, container, codec, track, durasi) sebelum unduhan; deteksi audio hening.
- Halaman Bantuan, Privasi, Lisensi; CI GitHub Actions (lint, format, typecheck, unit, build, E2E, audit).
