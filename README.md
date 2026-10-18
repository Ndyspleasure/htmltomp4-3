# HTML ke MP4 / MP3 Converter

Website statis (Astro + TypeScript + Tailwind CSS) untuk mengimpor animasi HTML (`.html` atau proyek `.zip`), menampilkan
preview terisolasi, merekam tab/jendela preview **dengan izin pengguna**, lalu mengekspor hasil yang sudah divalidasi ke
**MP4**, **MP3**, atau **WebM**. Semua proses berjalan di browser; tidak ada file yang diunggah ke server. Siap di-deploy
ke Vercel sebagai situs statis.

> Alurnya **preview → rekam tab/jendela dengan izin → konversi → validasi → unduh**. HTML adalah dokumen yang dirender
> browser, bukan file video, sehingga tidak ada janji bahwa setiap HTML bisa dikonversi otomatis. Detail desain ada di
> [`arsitektur.md`](arsitektur.md).

## Fitur

- **Import aman**: `.html` (≤ 10 MB) atau `.zip` (≤ 25 MB, ≤ 500 file, ≤ 100 MB setelah ekstrak) dengan penolakan path
  traversal, path absolut, dan ZIP bomb. ZIP diekstrak di Web Worker. Pemilihan entry point bila `index.html` tidak ada.
- **Preview terisolasi**: iframe `sandbox="allow-scripts"` (origin opaque) memuat `/sandbox.html`; HTML pengguna hanya
  di-parse di dalam sandbox. Aset lokal (CSS `url()`/`@import`, import modul ES, `fetch`, XHR, `src`, `new Audio()`)
  dipetakan ke `blob:` URL.
- **Dua mode rekam**: _Tab ini_ (Region Capture — hanya area preview yang terekam, Chrome/Edge) atau _jendela preview
  terpisah_ berukuran resolusi target. Animasi bisa dimulai ulang tepat saat perekaman dimulai.
- **Ekspor**: MP4 (H.264 + AAC; VP9/AV1 di MP4 berlabel “kompatibilitas terbatas” bila H.264 tidak tersedia), MP3
  (CBR 192 kbps), atau WebM. Encoding di Web Worker memakai [Mediabunny](https://mediabunny.dev) + WebCodecs, dengan encoder
  AAC/MP3 WebAssembly yang di-load hanya saat dibutuhkan.
- **Validasi output**: hasil dibaca ulang (signature + container + codec + track + durasi) sebelum tombol unduh muncul.
  Ekstensi `.mp4`/`.mp3` hanya diberikan pada file yang benar-benar berformat tersebut. Audio hening diberi peringatan.
- **Kemampuan browser terdeteksi** dan ditampilkan sebelum merekam (getDisplayMedia, MediaRecorder MIME, encoder per
  codec). Fitur yang tidak tersedia dinonaktifkan dengan alasan yang jelas.
- **Cleanup**: stream, worker, object URL, iframe, dan jendela preview dilepas saat selesai, gagal, dibatalkan, reset,
  atau tab ditutup.
- **Halaman** Bantuan & kompatibilitas, Privasi, Lisensi pihak ketiga.

## Dukungan browser

| Browser (desktop) | Rekam tab | Audio tab | Area preview di tab ini | MP4 H.264                 | MP3 |
| ----------------- | --------- | --------- | ----------------------- | ------------------------- | --- |
| Chrome / Edge     | ✓         | ✓         | ✓                       | ✓                         | ✓   |
| Firefox           | jendela   | ✗         | ✗                       | bergantung encoder sistem | ✗   |
| Safari (macOS)    | jendela   | ✗         | ✗                       | ✓ (WebCodecs)             | ✗   |
| Mobile (umumnya)  | ✗         | ✗         | ✗                       | –                         | –   |

Tabel di atas adalah ekspektasi berdasarkan dukungan API; aplikasi selalu memakai hasil deteksi nyata di browser
pengguna (panel “Kemampuan browser ini”). Yang sudah diuji otomatis: Chromium (lihat [Pengujian](#pengujian)).

## Menjalankan secara lokal

Prasyarat: Node.js **≥ 22.22** dan npm.

```bash
npm ci
npm run dev          # http://localhost:4321 (membangun sandbox loader lebih dulu)
```

Perekaman membutuhkan konteks aman: `localhost` atau HTTPS.

### Script

| Script                  | Fungsi                                                                                    |
| ----------------------- | ----------------------------------------------------------------------------------------- |
| `npm run dev`           | Dev server Astro.                                                                         |
| `npm run build`         | Build produksi ke `dist/` (menjalankan `build:sandbox` lebih dulu).                       |
| `npm run build:sandbox` | Membangun `src/sandbox/loader.ts` → `public/generated/sandbox-loader.js` (di-ignore Git). |
| `npm run preview`       | Menyajikan `dist/` dengan header dari `vercel.json` di port 4321.                         |
| `npm run lint`          | ESLint.                                                                                   |
| `npm run format:check`  | Prettier.                                                                                 |
| `npm run typecheck`     | `astro check` + `tsc --noEmit`.                                                           |
| `npm test`              | Unit test (Vitest).                                                                       |
| `npm run test:e2e`      | E2E (Playwright, Chromium) terhadap build produksi. Jalankan `npm run build` dulu.        |
| `npm run verify`        | Semua pemeriksaan di atas berurutan.                                                      |

## Pengujian

- **Unit (Vitest)**: validasi path/ukuran/ZIP bomb, import, penulisan ulang HTML/CSS/JS, loader sandbox, state machine,
  alur izin capture & MediaRecorder (dengan fake), opsi format, validasi output terhadap fixture media nyata, cleanup.
- **E2E (Playwright)** terhadap `dist/` yang disajikan dengan header `vercel.json`:
  - halaman & header keamanan (CSP tanpa `unsafe-inline`, tanpa error console);
  - isolasi sandbox (akses ke parent, `localStorage`, cookie, dan navigasi top diblokir);
  - proyek ZIP dengan CSS `@import`, `url()`, import modul, `fetch()`, dan gambar dinamis;
  - penolakan path traversal, ZIP bomb, tipe file salah;
  - rekam → konversi → validasi → unduh untuk MP4, MP3, WebM, ekspor ulang, izin ditolak, tanpa audio, batal, stop awal
    (stream capture tiruan yang deterministik);
  - **capture asli Chromium** (tanpa stub) dengan Region Capture.
  - File unduhan diperiksa dengan parser Mediabunny dan, bila tersedia, `ffprobe`.

Untuk E2E lokal: `npx playwright install chromium` (sekali), lalu `npm run build && npm run test:e2e`.

## Deploy ke Vercel

Proyek ini adalah situs statis tanpa environment variable, database, atau API route.

1. Import repository di Vercel (framework terdeteksi: **Astro**).
2. Pengaturan sudah ada di [`vercel.json`](vercel.json): `buildCommand: npm run build`, `outputDirectory: dist`, serta
   header keamanan (CSP, `frame-ancestors`, `nosniff`, `Permissions-Policy`, COOP, cache aset `/_astro/*`).
3. Node.js: `engines.node` = `>=22.22.0` (Vercel memakai versi Node yang tersedia dan memenuhi rentang tersebut).
4. Setelah deploy, uji di URL HTTPS: impor file, rekam di Chrome/Edge, unduh MP4 & MP3.

Atau dengan CLI: `npx vercel` (preview) / `npx vercel --prod`.

Tidak ada `.env` yang diperlukan.

## Struktur

```text
src/config/converter-config.ts   batas, preset, codec, bitrate (satu sumber)
src/features/converter/          validation, import, preview, capture, export, workers, state, cleanup, ui
src/sandbox/loader.ts            loader untuk /sandbox.html (berjalan di origin opaque)
src/pages/                       index, preview, bantuan, privasi, lisensi, 404
public/sandbox.html              halaman host sandbox
scripts/serve-dist.mjs           server statis + header vercel.json
tests/unit, tests/e2e            Vitest, Playwright
```

## Keterbatasan

- Tidak semua animasi tampil identik; video eksternal, WebGL, font eksternal, CORS, iframe lintas origin, DRM, dan konten
  yang butuh login dapat gagal. Preview tidak punya `localStorage`/cookie.
- Path aset yang dibentuk dinamis di luar API yang di-shim (mis. `new URL(..., import.meta.url)`, Worker dari file proyek)
  bisa gagal dimuat.
- Kualitas mengikuti resolusi tangkapan; mode “Tab ini” bisa lebih kecil dari target (aplikasi memberi tahu bila hasil
  diperbesar). Gunakan jendela preview untuk resolusi penuh.
- Audio tab hanya tersedia di Chromium desktop. MP3 tidak tersedia bila browser tidak memberikan audio tab.
- Durasi maksimum 300 detik; encoding memakai memori perangkat.

## Lisensi pihak ketiga

Mediabunny dan ekstensi encodernya (MPL-2.0; AAC berbasis FFmpeg/LGPL, MP3 berbasis LAME/LGPL), fflate (MIT),
es-module-lexer (MIT), Astro (MIT), Tailwind CSS (MIT). Lihat halaman `/lisensi`.
