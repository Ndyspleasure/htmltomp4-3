# Changelog

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
