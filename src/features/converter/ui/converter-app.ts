import {
  DEFAULT_SETTINGS,
  FRAME_RATES,
  MP4_VIDEO_CODECS,
  PREVIEW,
  RECORDING_LIMITS,
  RESOLUTION_PRESETS,
  type FrameRate,
  type Mp4VideoCodec,
  type ResolutionPresetId,
} from '../../../config/converter-config';
import { detectCapabilities, type BrowserCapabilities } from '../capture/capability-check';
import { cropToElement, cropToTarget, requestDisplayCapture, setCaptureHandle } from '../capture/display-capture';
import { startRecording, type RecordingSession } from '../capture/media-recorder';
import { ResourceTracker } from '../cleanup/resource-tracker';
import { ConverterError, isConverterError, toUserMessage } from '../errors';
import {
  EncoderClient,
  type ConvertRequest,
  type ConvertResult,
  type EncodeStage,
  type EncoderSupport,
} from '../export/encoder-client';
import { bestMp4Codec, formatAvailability } from '../export/export-options';
import { buildOutputFileName, formatBytes, formatDuration } from '../format';
import { importSource } from '../import/import-source';
import { readZipInWorker } from '../import/zip-client';
import { buildPreviewBundle } from '../preview/build-bundle';
import { mountPreview, type PreviewController } from '../preview/mount-preview';
import { StatusMachine, controlsFor } from '../state/state-machine';
import type {
  CaptureMode,
  ConversionResult,
  ConversionStatus,
  ConverterSettings,
  ImportedSource,
  OutputFormat,
  PreviewBundle,
  RecordingResult,
} from '../types';
import { PREVIEW_WINDOW_NAME, type OpenerToPreview, type PreviewToOpener } from './window-protocol';

const STATUS_LABELS: Record<ConversionStatus, string> = {
  idle: 'Menunggu file.',
  validating: 'Memvalidasi file…',
  'preparing-preview': 'Menyiapkan preview…',
  'ready-to-record': 'Siap merekam.',
  'requesting-permission': 'Menunggu izin perekaman dari browser…',
  recording: 'Sedang merekam.',
  processing: 'Memproses rekaman…',
  completed: 'Selesai. File siap diunduh.',
  cancelled: 'Dibatalkan.',
  error: 'Terjadi kesalahan.',
};

const STAGE_LABELS: Record<EncodeStage, string> = {
  'loading-encoder': 'Menyiapkan encoder…',
  'reading-input': 'Membaca rekaman…',
  encoding: 'Mengonversi',
  validating: 'Memvalidasi hasil…',
};

function q<T extends HTMLElement = HTMLElement>(root: ParentNode, name: string): T {
  const element = root.querySelector<T>(`[data-el="${name}"]`);
  if (!element) throw new Error(`Elemen UI "${name}" tidak ditemukan`);
  return element;
}

interface PopupState {
  win: Window;
  ready: boolean;
  /** CropTarget for the preview stage inside the window (Chromium Region Capture). */
  cropTarget: unknown;
  pendingRestart: { resolve: () => void; reject: (error: unknown) => void } | null;
}

export function initConverterApp(doc: Document): void {
  const ui = {
    globalError: q(doc, 'global-error'),
    compatBanner: q(doc, 'compat-banner'),
    statusText: q(doc, 'status-text'),
    dropzone: q(doc, 'dropzone'),
    fileInput: q<HTMLInputElement>(doc, 'file-input'),
    fileInfo: q(doc, 'file-info'),
    fileName: q(doc, 'file-name'),
    fileSize: q(doc, 'file-size'),
    fileContents: q(doc, 'file-contents'),
    fileList: q(doc, 'file-list'),
    entryWrapper: q(doc, 'entry-wrapper'),
    entrySelect: q<HTMLSelectElement>(doc, 'entry-select'),
    reset: q<HTMLButtonElement>(doc, 'reset'),
    importWarnings: q(doc, 'import-warnings'),
    previewHost: q(doc, 'preview-host'),
    previewEmpty: q(doc, 'preview-empty'),
    previewMeta: q(doc, 'preview-meta'),
    previewErrors: q(doc, 'preview-errors'),
    restartPreview: q<HTMLButtonElement>(doc, 'restart-preview'),
    openWindow: q<HTMLButtonElement>(doc, 'open-window'),
    settings: q<HTMLFormElement>(doc, 'settings'),
    formatNote: q(doc, 'format-note'),
    codecField: q(doc, 'codec-field'),
    resolutionField: q(doc, 'resolution-field'),
    fpsField: q(doc, 'fps-field'),
    modeThisTab: q(doc, 'mode-this-tab'),
    capabilityList: q(doc, 'capability-list'),
    recordGuide: q(doc, 'record-guide'),
    record: q<HTMLButtonElement>(doc, 'record'),
    stop: q<HTMLButtonElement>(doc, 'stop'),
    cancel: q<HTMLButtonElement>(doc, 'cancel'),
    recordingStatus: q(doc, 'recording-status'),
    recordingTime: q(doc, 'recording-time'),
    recordingLimit: q(doc, 'recording-limit'),
    recordingAudio: q(doc, 'recording-audio'),
    recordingSize: q(doc, 'recording-size'),
    progressSection: q(doc, 'progress-section'),
    progressStage: q(doc, 'progress-stage'),
    progressBar: q(doc, 'progress-bar'),
    cancelProcessing: q<HTMLButtonElement>(doc, 'cancel-processing'),
    resultSection: q(doc, 'result-section'),
    resultPlayer: q(doc, 'result-player'),
    resultMeta: q(doc, 'result-meta'),
    resultNotes: q(doc, 'result-notes'),
    resultPlayback: q(doc, 'result-playback'),
    download: q<HTMLAnchorElement>(doc, 'download'),
    reexport: q<HTMLButtonElement>(doc, 'reexport'),
    recordAgain: q<HTMLButtonElement>(doc, 'record-again'),
  };

  const machine = new StatusMachine();
  const encoder = new EncoderClient();
  /** Resources tied to the imported source (preview, popup window). */
  const sourceResources = new ResourceTracker();
  /** Resources tied to one recording/export run (streams, result URL). */
  const runResources = new ResourceTracker();
  const caps: BrowserCapabilities = detectCapabilities();
  const sessionId = crypto.randomUUID();
  const mainHandle = `h2m-main:${sessionId}`;
  const windowHandle = `h2m-preview:${sessionId}`;
  setCaptureHandle(mainHandle);

  let source: ImportedSource | null = null;
  let bundle: PreviewBundle | null = null;
  let preview: PreviewController | null = null;
  let popup: PopupState | null = null;
  let support: EncoderSupport | null = null;
  let probeKey = '';
  let recording: RecordingResult | null = null;
  let recordingSession: RecordingSession | null = null;
  let processingAbort: AbortController | null = null;
  let importToken = 0;
  /** Warnings from the import step, shown together with preview warnings. */
  let importWarningsCache: string[] = [];

  // ---------- settings ----------

  function readSettings(): ConverterSettings {
    // Read element state directly: FormData skips disabled fields, and fields are disabled during transitions.
    const form = ui.settings;
    const field = (name: string): string | null => {
      const radio = form.querySelector<HTMLInputElement>(`input[type="radio"][name="${name}"]:checked`);
      if (radio) return radio.value;
      return form.querySelector<HTMLInputElement | HTMLSelectElement>(`[name="${name}"]`)?.value ?? null;
    };
    const checked = (name: string) =>
      form.querySelector<HTMLInputElement>(`input[type="checkbox"][name="${name}"]`)?.checked === true;

    const preset = RESOLUTION_PRESETS.find((p) => p.id === field('resolutionId')) ?? RESOLUTION_PRESETS[0];
    const fps = Number(field('frameRate'));
    const frameRate: FrameRate = (FRAME_RATES as readonly number[]).includes(fps)
      ? (fps as FrameRate)
      : DEFAULT_SETTINGS.frameRate;
    const rawDuration = Math.round(Number(field('durationSeconds')));
    const durationSeconds = Number.isFinite(rawDuration)
      ? Math.min(RECORDING_LIMITS.maxDurationSeconds, Math.max(RECORDING_LIMITS.minDurationSeconds, rawDuration))
      : DEFAULT_SETTINGS.durationSeconds;
    const format = field('outputFormat');
    const outputFormat: OutputFormat = format === 'mp3' || format === 'webm' ? format : 'mp4';
    const codec = field('mp4VideoCodec');
    const mp4VideoCodec: Mp4VideoCodec = MP4_VIDEO_CODECS.find((c) => c.codec === codec)?.codec ?? 'avc';
    const captureMode: CaptureMode = field('captureMode') === 'this-tab' ? 'this-tab' : 'preview-window';
    return {
      outputFormat,
      resolutionId: preset.id as ResolutionPresetId,
      width: preset.width,
      height: preset.height,
      frameRate,
      durationSeconds,
      includeAudio: checked('includeAudio'),
      restartOnRecord: checked('restartOnRecord'),
      mp4VideoCodec,
      captureMode,
    };
  }

  function initCaptureModeDefault(): void {
    const thisTab = ui.settings.querySelector<HTMLInputElement>('input[name="captureMode"][value="this-tab"]');
    const windowMode = ui.settings.querySelector<HTMLInputElement>('input[name="captureMode"][value="preview-window"]');
    if (!thisTab || !windowMode) return;
    if (caps.regionCapture) {
      thisTab.checked = true;
    } else {
      thisTab.disabled = true;
      windowMode.checked = true;
      ui.modeThisTab.title = 'Browser ini tidak mendukung Region Capture.';
    }
  }

  // ---------- status & controls ----------

  function setStatus(next: ConversionStatus): void {
    machine.to(next);
  }

  machine.subscribe((status) => {
    ui.statusText.textContent = STATUS_LABELS[status];
    updateControls();
  });

  function updateControls(): void {
    const status = machine.status;
    const controls = controlsFor(status);
    const settings = readSettings();
    const availability = support ? currentAvailability(settings) : null;
    const windowReady = settings.captureMode === 'this-tab' || popup?.ready === true;

    ui.fileInput.disabled = !controls.canPickFile;
    ui.reset.disabled = status === 'recording' || status === 'processing' || status === 'requesting-permission';
    ui.entrySelect.disabled = !controls.canRestartPreview;
    ui.restartPreview.disabled = !preview || !controls.canRestartPreview;
    ui.openWindow.disabled = !bundle || !controls.canRestartPreview;
    ui.settings.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select').forEach((field) => {
      if (field.dataset['locked'] === 'true') return;
      field.disabled = !(controls.canEditSettings || status === 'idle');
    });
    applyFormatLocks();
    ui.record.disabled = !(controls.canRecord && bundle && availability?.available && windowReady);
    ui.stop.disabled = !controls.canStop;
    ui.cancel.disabled = !controls.canCancel;
    ui.cancelProcessing.disabled = status !== 'processing';
    ui.reexport.disabled = !(recording && (status === 'completed' || status === 'error' || status === 'cancelled'));
    ui.recordAgain.disabled = !controls.canRecord;
    ui.recordingStatus.classList.toggle('hidden', status !== 'recording');
    ui.progressSection.classList.toggle('hidden', status !== 'processing');
    renderGuide(settings);
  }

  function currentAvailability(settings: ConverterSettings) {
    if (!support) return { available: false, reason: 'Memeriksa kemampuan encoder…' };
    return formatAvailability(
      settings.outputFormat,
      support,
      { video: caps.recorderVideoMime, audio: caps.recorderAudioMime },
      caps.displayCapture && caps.secureContext,
    );
  }

  function applyFormatLocks(): void {
    const settings = readSettings();
    const isMp3 = settings.outputFormat === 'mp3';
    ui.codecField.classList.toggle('hidden', settings.outputFormat !== 'mp4');
    ui.resolutionField.classList.toggle('opacity-50', isMp3);
    ui.fpsField.classList.toggle('opacity-50', isMp3);
    const includeAudio = ui.settings.querySelector<HTMLInputElement>('input[name="includeAudio"]');
    if (includeAudio) {
      if (isMp3) includeAudio.checked = true;
      includeAudio.disabled = isMp3 || includeAudio.disabled;
    }
    if (support) {
      ui.settings.querySelectorAll<HTMLInputElement>('input[name="outputFormat"]').forEach((radio) => {
        const result = formatAvailability(
          radio.value as OutputFormat,
          support as EncoderSupport,
          { video: caps.recorderVideoMime, audio: caps.recorderAudioMime },
          caps.displayCapture && caps.secureContext,
        );
        radio.title = result.available ? '' : (result.reason ?? '');
      });
      const select = ui.settings.querySelector<HTMLSelectElement>('select[name="mp4VideoCodec"]');
      select?.querySelectorAll('option').forEach((option) => {
        const ok = support?.mp4Video[option.value as Mp4VideoCodec] ?? false;
        option.disabled = !ok;
        option.textContent = option.textContent.replace(/ — tidak tersedia$/, '') + (ok ? '' : ' — tidak tersedia');
      });
      const availability = currentAvailability(settings);
      const codecMeta = MP4_VIDEO_CODECS.find((c) => c.codec === settings.mp4VideoCodec);
      const notes: string[] = [];
      if (!availability.available)
        notes.push(`⚠ ${availability.reason ?? 'Format ini tidak tersedia di browser ini.'}`);
      else if (availability.reason) notes.push(availability.reason);
      if (settings.outputFormat === 'mp4' && codecMeta?.limitedCompatibility && availability.available) {
        notes.push(
          `${codecMeta.label} di dalam MP4 adalah file MP4 yang valid, tetapi tidak semua pemutar (mis. QuickTime lama) bisa memutarnya.`,
        );
      }
      if (settings.outputFormat === 'mp3')
        notes.push('MP3 membutuhkan audio tab. Centang “Bagikan audio tab” di dialog izin.');
      if (settings.outputFormat === 'webm')
        notes.push('WebM adalah alternatif jujur bila MP4 tidak dapat dibuat di browser ini.');
      ui.formatNote.textContent = notes.join(' ');
    }
  }

  function renderGuide(settings: ConverterSettings): void {
    const steps =
      settings.captureMode === 'this-tab'
        ? [
            'Klik “Mulai Rekam”.',
            'Di dialog browser pilih “Tab ini” (tab converter). Hanya area preview yang direkam.',
            settings.outputFormat === 'mp3' || settings.includeAudio
              ? 'Pastikan “Bagikan audio tab” aktif.'
              : 'Audio tidak disertakan.',
            'Biarkan area preview terlihat sampai rekaman selesai.',
          ]
        : [
            'Klik “Buka jendela preview” (tab “Preview Rekaman” akan terbuka).',
            'Kembali ke tab ini lalu klik “Mulai Rekam”.',
            'Di dialog browser pilih tab “Preview Rekaman” — bukan tab converter ini.',
            settings.outputFormat === 'mp3' || settings.includeAudio
              ? 'Pastikan “Bagikan audio tab” aktif.'
              : 'Audio tidak disertakan.',
          ];
    if (settings.captureMode === 'preview-window' && popup && !popup.ready)
      steps.push('Menunggu jendela preview siap…');
    ui.recordGuide.replaceChildren(...steps.map((text) => listItem(text)));
  }

  // ---------- errors ----------

  function showError(error: unknown): void {
    ui.globalError.textContent = toUserMessage(error);
    ui.globalError.classList.remove('hidden');
    if (!isConverterError(error)) console.error(error);
  }

  function clearError(): void {
    ui.globalError.textContent = '';
    ui.globalError.classList.add('hidden');
  }

  function renderList(target: HTMLElement, items: string[]): void {
    target.replaceChildren(...items.map((text) => listItem(text)));
    target.classList.toggle('hidden', items.length === 0);
  }

  // ---------- import & preview ----------

  async function handleFile(file: File): Promise<void> {
    if (machine.status === 'recording' || machine.status === 'processing' || machine.status === 'requesting-permission')
      return;
    const token = ++importToken;
    resetAll();
    clearError();
    setStatus('validating');
    try {
      const outcome = await importSource(file, { readZipImpl: readZipInWorker });
      if (token !== importToken) return;
      source = outcome.source;
      importWarningsCache = outcome.warnings;
      renderSourceInfo(outcome.source, outcome.warnings);
      await preparePreview(outcome.source.htmlEntries[0] ?? '');
    } catch (error) {
      if (token !== importToken) return;
      source = null;
      showError(error);
      setStatus('error');
    }
  }

  function renderSourceInfo(imported: ImportedSource, warnings: string[]): void {
    ui.fileInfo.classList.remove('hidden');
    ui.fileName.textContent = imported.name;
    ui.fileSize.textContent = formatBytes(imported.sizeBytes);
    ui.fileContents.textContent =
      imported.kind === 'zip'
        ? `${imported.files.length} file, ${formatBytes(imported.totalExtractedBytes)} setelah diekstrak`
        : 'Dokumen HTML tunggal';
    ui.fileList.replaceChildren(
      ...imported.files.map((f) => listItem(`${f.path} (${formatBytes(f.data.byteLength)})`)),
    );
    ui.entrySelect.replaceChildren(
      ...imported.htmlEntries.map((entry) => {
        const option = doc.createElement('option');
        option.value = entry;
        option.textContent = entry;
        return option;
      }),
    );
    ui.entryWrapper.classList.toggle('hidden', imported.htmlEntries.length < 2);
    renderList(ui.importWarnings, warnings);
  }

  async function preparePreview(entryPath: string): Promise<void> {
    if (!source) return;
    setStatus('preparing-preview');
    sourceResources.release('preview');
    sourceResources.release('popup');
    renderList(ui.previewErrors, []);
    const built = buildPreviewBundle(source, entryPath);
    bundle = built;
    renderList(ui.importWarnings, [...importWarningsCache, ...built.warnings]);
    const settings = readSettings();
    ui.previewEmpty.classList.add('hidden');
    const controller = mountPreview(ui.previewHost, built, {
      width: settings.width,
      height: settings.height,
      onEvent: (event) => {
        if (event.type === 'runtime-error') appendPreviewError(`Error JavaScript di animasi: ${event.message}`);
        if (event.type === 'loaded')
          renderList(ui.importWarnings, [...importWarningsCache, ...built.warnings, ...event.warnings]);
      },
    });
    preview = controller;
    sourceResources.add(() => {
      controller.destroy();
      if (preview === controller) preview = null;
      ui.previewEmpty.classList.remove('hidden');
      ui.previewHost.append(ui.previewEmpty);
    }, 'preview');
    try {
      await controller.ready;
      ui.previewMeta.textContent = `Viewport ${settings.width}×${settings.height}px · entry: ${entryPath}`;
      setStatus('ready-to-record');
      void refreshSupport();
    } catch (error) {
      showError(error);
      setStatus('error');
    }
  }

  function appendPreviewError(text: string): void {
    const items = [...ui.previewErrors.querySelectorAll('li')].map((li) => li.textContent);
    if (items.length >= 5 || items.includes(text)) return;
    renderList(ui.previewErrors, [...items, text]);
  }

  async function refreshSupport(): Promise<void> {
    const settings = readSettings();
    const key = `${settings.width}x${settings.height}`;
    if (key === probeKey && support) return;
    probeKey = key;
    try {
      const result = await encoder.probe(settings.width, settings.height);
      if (probeKey !== key) return;
      support = result;
      const best = bestMp4Codec(result);
      const select = ui.settings.querySelector<HTMLSelectElement>('select[name="mp4VideoCodec"]');
      if (select && best && !result.mp4Video[select.value as Mp4VideoCodec]) select.value = best;
      renderCapabilities();
    } catch (error) {
      support = null;
      showError(error);
    }
    updateControls();
  }

  function renderCapabilities(): void {
    const yes = (ok: boolean) => (ok ? '✓' : '✗');
    const lines = [
      `${yes(caps.secureContext)} Konteks aman (HTTPS)`,
      `${yes(caps.displayCapture)} Perekaman tab/jendela (getDisplayMedia)`,
      `${yes(caps.mediaRecorder)} MediaRecorder — video: ${caps.recorderVideoMime ?? 'tidak didukung'}, audio: ${caps.recorderAudioMime ?? 'tidak didukung'}`,
      `${yes(caps.regionCapture)} Rekam area preview di tab ini (Region Capture)`,
      `${yes(caps.captureHandle)} Verifikasi tab yang dipilih (Capture Handle)`,
    ];
    if (support) {
      lines.push(`${yes(support.webCodecs)} WebCodecs (encoder video di perangkat)`);
      for (const { codec, label } of MP4_VIDEO_CODECS)
        lines.push(`${yes(support.mp4Video[codec])} Encoder ${label} untuk MP4`);
      lines.push(
        `${yes(Boolean(support.aac))} Encoder AAC ${support.aac === 'wasm' ? '(WebAssembly)' : support.aac === 'native' ? '(bawaan browser)' : ''}`,
      );
      lines.push(
        `${yes(Boolean(support.mp3))} Encoder MP3 ${support.mp3 === 'wasm' ? '(WebAssembly)' : support.mp3 === 'native' ? '(bawaan browser)' : ''}`,
      );
      lines.push(
        `${yes(Boolean(support.webmVideo))} Encoder WebM ${support.webmVideo ? `(${support.webmVideo.toUpperCase()})` : ''}`,
      );
    }
    ui.capabilityList.replaceChildren(...lines.map((text) => listItem(text)));
  }

  function renderCompatBanner(): void {
    const problems: string[] = [];
    if (!caps.secureContext) problems.push('Halaman tidak dibuka lewat HTTPS, sehingga perekaman tidak tersedia.');
    if (!caps.displayCapture)
      problems.push(
        'Browser ini tidak mendukung perekaman tab/jendela. Gunakan Chrome, Edge, atau Firefox versi desktop.',
      );
    if (!caps.mediaRecorder) problems.push('Browser ini tidak memiliki MediaRecorder.');
    if (caps.likelyMobile)
      problems.push(
        'Perangkat mobile umumnya tidak mendukung perekaman tab. Gunakan komputer desktop untuk hasil terbaik.',
      );
    ui.compatBanner.textContent = problems.join(' ');
    ui.compatBanner.classList.toggle('hidden', problems.length === 0);
  }

  // ---------- preview window ----------

  function openPreviewWindow(): void {
    if (!bundle) return;
    const settings = readSettings();
    if (popup && !popup.win.closed) {
      popup.win.focus();
      return;
    }
    const features = `popup,width=${settings.width},height=${settings.height}`;
    const win = window.open('/preview', PREVIEW_WINDOW_NAME, features);
    if (!win) {
      showError(
        new ConverterError(
          'popup-blocked',
          'Jendela preview diblokir browser. Izinkan pop-up untuk situs ini lalu coba lagi.',
        ),
      );
      return;
    }
    const state: PopupState = { win, ready: false, cropTarget: undefined, pendingRestart: null };
    popup = state;
    const timer = window.setInterval(() => {
      if (win.closed) {
        sourceResources.release('popup');
      }
    }, 500);
    sourceResources.add(() => {
      window.clearInterval(timer);
      state.pendingRestart?.reject(new ConverterError('preview-failed', 'Jendela preview ditutup.'));
      if (!win.closed) win.close();
      if (popup === state) popup = null;
      updateControls();
    }, 'popup');
    updateControls();
  }

  window.addEventListener('message', (event: MessageEvent<PreviewToOpener>) => {
    if (!popup || event.source !== popup.win || event.origin !== location.origin) return;
    const message = event.data;
    const settings = readSettings();
    if (message.type === 'h2m:preview-hello' && bundle) {
      const init: OpenerToPreview = {
        type: 'h2m:preview-init',
        bundle,
        width: settings.width,
        height: settings.height,
        handle: windowHandle,
        title: `● Preview Rekaman — ${source?.name ?? 'animasi'}`,
      };
      popup.win.postMessage(init, location.origin);
    } else if (message.type === 'h2m:preview-ready') {
      popup.ready = true;
      popup.cropTarget = message.cropTarget;
      updateControls();
    } else if (message.type === 'h2m:preview-restarted') {
      popup.pendingRestart?.resolve();
      popup.pendingRestart = null;
    } else if (message.type === 'h2m:preview-error') {
      popup.pendingRestart?.reject(new ConverterError('preview-failed', message.message));
      popup.pendingRestart = null;
      appendPreviewError(`Jendela preview: ${String(message.message).slice(0, 300)}`);
    }
  });

  function restartPreviewWindow(): Promise<void> {
    const state = popup;
    if (!state || state.win.closed)
      return Promise.reject(new ConverterError('preview-failed', 'Jendela preview sudah ditutup.'));
    return new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        state.pendingRestart = null;
        reject(new ConverterError('preview-failed', 'Jendela preview tidak merespons.'));
      }, PREVIEW.loaderTimeoutMs);
      state.pendingRestart = {
        resolve: () => {
          window.clearTimeout(timer);
          resolve();
        },
        reject: (error) => {
          window.clearTimeout(timer);
          reject(error);
        },
      };
      state.win.postMessage({ type: 'h2m:preview-restart' } satisfies OpenerToPreview, location.origin);
    });
  }

  // ---------- recording ----------

  async function startRecordingFlow(): Promise<void> {
    if (!bundle || !preview) return;
    clearError();
    const settings = readSettings();
    const availability = currentAvailability(settings);
    if (!availability.available) {
      showError(new ConverterError('codec-unavailable', availability.reason ?? 'Format tidak tersedia.'));
      return;
    }
    const mimeType = settings.outputFormat === 'mp3' ? caps.recorderAudioMime : caps.recorderVideoMime;
    if (!mimeType) {
      showError(
        new ConverterError(
          'recorder-unsupported',
          'MediaRecorder tidak mendukung format rekaman apa pun di browser ini.',
        ),
      );
      return;
    }
    if (settings.captureMode === 'preview-window' && !popup?.ready) {
      showError(new ConverterError('preview-failed', 'Buka jendela preview terlebih dahulu dan tunggu sampai siap.'));
      return;
    }

    hideResult();
    runResources.releaseAll();
    recording = null;
    setStatus('requesting-permission');
    const stage = ui.previewHost.querySelector('.h2m-stage') ?? ui.previewHost;
    if (settings.captureMode === 'this-tab') stage.scrollIntoView({ block: 'center', behavior: 'instant' });

    try {
      const wantAudio = settings.outputFormat === 'mp3' || settings.includeAudio;
      const capture = await requestDisplayCapture({
        mode: settings.captureMode,
        frameRate: settings.frameRate,
        wantAudio,
        ...(caps.captureHandle
          ? { expectedHandle: settings.captureMode === 'this-tab' ? mainHandle : windowHandle }
          : {}),
      });
      runResources.trackStream(capture.stream, 'stream');
      const warnings = [...capture.warnings];

      if (settings.outputFormat === 'mp3' && !capture.audioTrack) {
        throw new ConverterError(
          'no-audio-track',
          'Browser tidak memberikan audio tab. MP3 tidak dapat dibuat. Ulangi dan aktifkan “Bagikan audio tab” (didukung di Chrome/Edge desktop).',
        );
      }
      if (settings.captureMode === 'this-tab') {
        const cropped = await cropToElement(capture.videoTrack, stage).catch(() => false);
        if (!cropped) warnings.push('Area preview tidak dapat dipotong; seluruh tab ikut terekam.');
      } else if (popup?.cropTarget) {
        // Fails harmlessly when the user picked a surface other than the preview window.
        await cropToTarget(capture.videoTrack, popup.cropTarget).catch(() => false);
      }
      if (settings.restartOnRecord) {
        if (settings.captureMode === 'this-tab') await preview.restart();
        else await restartPreviewWindow();
      }

      const session = startRecording(capture.stream, {
        mimeType,
        audioOnly: settings.outputFormat === 'mp3',
        includeAudio: wantAudio,
        maxDurationMs: settings.durationSeconds * 1000,
        onTick: (elapsed) => {
          ui.recordingTime.textContent = formatDuration(elapsed / 1000);
        },
        onAutoStop: (reason) => {
          ui.statusText.textContent =
            reason === 'limit'
              ? 'Durasi maksimum tercapai, perekaman dihentikan.'
              : 'Berbagi layar dihentikan, perekaman selesai.';
        },
      });
      recordingSession = session;
      ui.recordingTime.textContent = '00:00';
      ui.recordingLimit.textContent = formatDuration(settings.durationSeconds);
      ui.recordingAudio.textContent = capture.audioTrack
        ? '🔊 Track audio terdeteksi.'
        : wantAudio
          ? '🔇 Tidak ada track audio — hasil tanpa suara.'
          : '🔇 Audio tidak disertakan.';
      ui.recordingSize.textContent = warnings.join(' ');
      setStatus('recording');

      const result = await session.done;
      recordingSession = null;
      runResources.release('stream');
      recording = result;
      await exportRecording(result, settings);
    } catch (error) {
      recordingSession = null;
      runResources.release('stream');
      if (isConverterError(error) && error.code === 'cancelled') {
        setStatus('cancelled');
        ui.statusText.textContent = 'Perekaman dibatalkan.';
        return;
      }
      showError(error);
      if (machine.status !== 'error') setStatus('error');
    }
  }

  // ---------- export ----------

  async function exportRecording(rec: RecordingResult, settings: ConverterSettings): Promise<void> {
    if (settings.outputFormat === 'mp3' && !rec.hasAudio) {
      showError(
        new ConverterError('no-audio-track', 'Rekaman ini tidak memiliki audio, sehingga tidak bisa diekspor ke MP3.'),
      );
      setStatus('error');
      return;
    }
    if (settings.outputFormat !== 'mp3' && !rec.hasVideo) {
      showError(
        new ConverterError('no-video-track', 'Rekaman ini hanya berisi audio. Rekam ulang untuk membuat video.'),
      );
      setStatus('error');
      return;
    }
    clearError();
    hideResult();
    setStatus('processing');
    const abort = new AbortController();
    processingAbort = abort;
    setProgress('loading-encoder', null, settings.outputFormat);
    const request: ConvertRequest = {
      blob: rec.blob,
      format: settings.outputFormat,
      width: settings.width,
      height: settings.height,
      frameRate: settings.frameRate,
      includeAudio: settings.includeAudio,
      mp4VideoCodec: settings.mp4VideoCodec,
    };
    try {
      let converted: ConvertResult;
      try {
        converted = await encoder.convert(
          request,
          (stage, fraction) => setProgress(stage, fraction, settings.outputFormat),
          abort.signal,
        );
      } catch (error) {
        if (!(isConverterError(error) && error.code === 'worker-failed')) throw error;
        // Module workers unavailable: run the same conversion on the main thread as a last resort.
        const { convertRecording } = await import('../export/convert-media');
        converted = await convertRecording(
          request,
          (stage, fraction) => setProgress(stage, fraction, settings.outputFormat),
          abort.signal,
        );
        converted.notes.push('Web Worker tidak tersedia; konversi dijalankan di thread utama.');
      }
      const extension = settings.outputFormat;
      const result: ConversionResult = {
        blob: new Blob([converted.buffer], { type: converted.mimeType }),
        fileName: buildOutputFileName(source?.name ?? 'animasi', extension),
        mimeType: converted.mimeType,
        sizeBytes: converted.buffer.byteLength,
        durationSeconds: converted.inspection.durationSeconds,
        ...(converted.inspection.video
          ? {
              width: converted.inspection.video.width,
              height: converted.inspection.video.height,
              videoCodec: converted.inspection.video.codec ?? '-',
            }
          : {}),
        ...(converted.inspection.audio ? { audioCodec: converted.inspection.audio.codec ?? '-' } : {}),
        ...(converted.audioSilent !== null ? { audioSilent: converted.audioSilent } : {}),
        limitedCompatibility: converted.limitedCompatibility,
        notes: converted.notes,
      };
      if (rec.captureWidth && rec.captureHeight && settings.outputFormat !== 'mp3') {
        if (rec.captureWidth < settings.width * 0.9 || rec.captureHeight < settings.height * 0.9) {
          result.notes.push(
            `Resolusi tangkapan ${rec.captureWidth}×${rec.captureHeight} lebih kecil dari target; hasil diperbesar dan bisa kurang tajam. Gunakan jendela preview terpisah untuk kualitas penuh.`,
          );
        }
      }
      showResult(result);
      setStatus('completed');
    } catch (error) {
      if (isConverterError(error) && error.code === 'encoding-cancelled') {
        setStatus('cancelled');
        ui.statusText.textContent = 'Konversi dibatalkan.';
      } else {
        showError(error);
        setStatus('error');
      }
    } finally {
      processingAbort = null;
    }
  }

  function setProgress(stage: EncodeStage, fraction: number | null, format: OutputFormat): void {
    const what = format === 'mp3' ? 'audio ke MP3' : `video ke ${format.toUpperCase()}`;
    const label = stage === 'encoding' ? `${STAGE_LABELS.encoding} ${what}…` : STAGE_LABELS[stage];
    if (fraction === null) {
      ui.progressStage.textContent = label;
      ui.progressBar.style.width = '100%';
      ui.progressBar.classList.add('animate-pulse', 'opacity-40');
      ui.progressBar.removeAttribute('aria-valuenow');
    } else {
      const percent = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
      ui.progressStage.textContent = `${label} ${percent}%`;
      ui.progressBar.style.width = `${percent}%`;
      ui.progressBar.classList.remove('animate-pulse', 'opacity-40');
      ui.progressBar.setAttribute('aria-valuenow', String(percent));
    }
  }

  // ---------- result ----------

  function showResult(result: ConversionResult): void {
    const url = URL.createObjectURL(result.blob);
    runResources.trackObjectUrl(url, 'result-url');
    const isAudio = result.mimeType.startsWith('audio/');
    const media = doc.createElement(isAudio ? 'audio' : 'video');
    media.controls = true;
    media.preload = 'metadata';
    media.src = url;
    media.className = isAudio ? 'w-full' : 'max-h-[60vh] max-w-full';
    media.setAttribute('aria-label', 'Pratinjau hasil');
    ui.resultPlayback.textContent = 'Memeriksa apakah browser dapat memutar hasil…';
    media.addEventListener('loadedmetadata', () => {
      ui.resultPlayback.textContent = '✓ Hasil dapat diputar oleh browser ini.';
    });
    media.addEventListener('error', () => {
      ui.resultPlayback.textContent =
        'Browser ini tidak dapat memutar pratinjau, tetapi file lolos validasi format. Coba putar dengan pemutar lain (mis. VLC).';
    });
    ui.resultPlayer.replaceChildren(media);
    runResources.add(() => {
      media.removeAttribute('src');
      media.load();
    }, 'result-media');

    const rows: [string, string][] = [
      ['Format', `${result.mimeType}${result.limitedCompatibility ? ' (kompatibilitas terbatas)' : ''}`],
      ['Ukuran', formatBytes(result.sizeBytes)],
      ['Durasi', result.durationSeconds !== undefined ? `${result.durationSeconds.toFixed(2)} detik` : '-'],
    ];
    if (result.width && result.height) rows.push(['Resolusi', `${result.width}×${result.height}`]);
    if (result.videoCodec) rows.push(['Codec video', result.videoCodec.toUpperCase()]);
    if (result.audioCodec) rows.push(['Codec audio', result.audioCodec.toUpperCase()]);
    ui.resultMeta.replaceChildren(
      ...rows.flatMap(([term, value]) => {
        const dt = doc.createElement('dt');
        dt.className = 'font-medium';
        dt.textContent = term;
        const dd = doc.createElement('dd');
        dd.textContent = value;
        return [dt, dd];
      }),
    );
    renderList(ui.resultNotes, result.notes);
    ui.download.href = url;
    ui.download.download = result.fileName;
    ui.download.textContent = `Unduh ${result.fileName}`;
    ui.resultSection.classList.remove('hidden');
    ui.resultSection.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function hideResult(): void {
    runResources.release('result-media');
    runResources.release('result-url');
    ui.resultSection.classList.add('hidden');
    ui.resultPlayer.replaceChildren();
    ui.download.removeAttribute('href');
  }

  // ---------- reset ----------

  function resetAll(): void {
    recordingSession?.cancel();
    recordingSession = null;
    processingAbort?.abort();
    processingAbort = null;
    runResources.releaseAll();
    sourceResources.releaseAll();
    hideResult();
    source = null;
    bundle = null;
    recording = null;
    importWarningsCache = [];
    ui.fileInfo.classList.add('hidden');
    renderList(ui.importWarnings, []);
    renderList(ui.previewErrors, []);
    ui.previewMeta.textContent = '';
    if (machine.status !== 'idle') setStatus('idle');
  }

  // ---------- events ----------

  ui.fileInput.addEventListener('change', () => {
    const file = ui.fileInput.files?.[0];
    ui.fileInput.value = '';
    if (file) void handleFile(file);
  });

  ui.dropzone.addEventListener('dragover', (event) => {
    event.preventDefault();
    ui.dropzone.dataset['drag'] = 'true';
  });
  ui.dropzone.addEventListener('dragleave', () => {
    ui.dropzone.dataset['drag'] = 'false';
  });
  ui.dropzone.addEventListener('drop', (event) => {
    event.preventDefault();
    ui.dropzone.dataset['drag'] = 'false';
    const files = event.dataTransfer?.files;
    if (!files || files.length === 0) return;
    if (files.length > 1) {
      showError(
        new ConverterError('unsupported-file-type', 'Pilih satu file saja. Untuk banyak file, kemas dalam satu ZIP.'),
      );
      return;
    }
    const file = files[0];
    if (file && !ui.fileInput.disabled) void handleFile(file);
  });
  // Prevent the browser from navigating away when a file is dropped outside the dropzone.
  window.addEventListener('dragover', (event) => event.preventDefault());
  window.addEventListener('drop', (event) => event.preventDefault());

  ui.reset.addEventListener('click', () => {
    importToken++;
    resetAll();
    clearError();
  });

  ui.entrySelect.addEventListener('change', () => {
    if (!source) return;
    clearError();
    void preparePreview(ui.entrySelect.value);
  });

  ui.restartPreview.addEventListener('click', () => {
    preview?.restart().catch(showError);
    if (popup?.ready) restartPreviewWindow().catch(showError);
  });

  ui.openWindow.addEventListener('click', openPreviewWindow);

  ui.settings.addEventListener('change', (event) => {
    const target = event.target as HTMLInputElement | null;
    if (target?.name === 'durationSeconds') {
      const settings = readSettings();
      target.value = String(settings.durationSeconds);
    }
    if (target?.name === 'resolutionId') {
      const settings = readSettings();
      preview?.setViewport(settings.width, settings.height);
      if (popup && !popup.win.closed) {
        popup.win.postMessage(
          { type: 'h2m:preview-resize', width: settings.width, height: settings.height } satisfies OpenerToPreview,
          location.origin,
        );
      }
      ui.previewMeta.textContent = `Viewport ${settings.width}×${settings.height}px · entry: ${bundle?.entryPath ?? '-'}`;
      if (bundle) void refreshSupport();
    }
    updateControls();
  });
  ui.settings.addEventListener('submit', (event) => event.preventDefault());

  ui.record.addEventListener('click', () => void startRecordingFlow());
  ui.recordAgain.addEventListener('click', () => void startRecordingFlow());
  ui.stop.addEventListener('click', () => recordingSession?.stop());
  ui.cancel.addEventListener('click', () => {
    if (machine.status === 'recording') recordingSession?.cancel();
    else processingAbort?.abort();
  });
  ui.cancelProcessing.addEventListener('click', () => processingAbort?.abort());
  ui.reexport.addEventListener('click', () => {
    if (recording) void exportRecording(recording, readSettings());
  });

  window.addEventListener('pagehide', () => {
    recordingSession?.cancel();
    processingAbort?.abort();
    runResources.releaseAll();
    sourceResources.releaseAll();
    encoder.dispose();
  });

  initCaptureModeDefault();
  renderCompatBanner();
  renderCapabilities();
  updateControls();
  ui.statusText.textContent = STATUS_LABELS.idle;

  function listItem(text: string): HTMLLIElement {
    const li = doc.createElement('li');
    li.textContent = text;
    return li;
  }

  // Expose minimal hooks for automated end-to-end tests only.
  (window as unknown as { __h2m?: unknown }).__h2m = {
    get status() {
      return machine.status;
    },
  };
}
