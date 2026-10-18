import { strToU8, zipSync } from 'fflate';

/** 1x1 red PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
  'base64',
);

export function zipBuffer(files: Record<string, string | Uint8Array>): Buffer {
  const entries: Record<string, Uint8Array> = {};
  for (const [name, data] of Object.entries(files)) entries[name] = typeof data === 'string' ? strToU8(data) : data;
  return Buffer.from(zipSync(entries));
}

/** A realistic multi-file project: wrapper folder, CSS with url(), module imports, fetch() and Image(). */
export function projectZip(): Buffer {
  return zipBuffer({
    'project/index.html': `<!doctype html><html><head>
      <link rel="stylesheet" href="css/style.css">
      <script type="module" src="js/main.js"></script>
      </head><body><h1 id="title">loading</h1><div id="bg" class="bg"></div><img id="img" src="img/dot.png">
      <p id="data">pending</p><p id="dynimg">pending</p></body></html>`,
    'project/css/style.css': '@import "theme.css"; .bg{width:10px;height:10px;background:url(../img/dot.png)}',
    'project/css/theme.css': '#title{color: rgb(255, 0, 0)}',
    'project/js/main.js': `import { label } from './lib/label.js';
      document.getElementById('title').textContent = label;
      fetch('data/info.json').then(r => r.json()).then(j => { document.getElementById('data').textContent = j.message; });
      const im = new Image(); im.onload = () => { document.getElementById('dynimg').textContent = 'loaded ' + im.naturalWidth; };
      im.onerror = () => { document.getElementById('dynimg').textContent = 'error'; }; im.src = 'img/dot.png';`,
    'project/js/lib/label.js': "export const label = 'Module OK';",
    'project/data/info.json': JSON.stringify({ message: 'Fetch OK' }),
    'project/img/dot.png': new Uint8Array(PNG),
  });
}

export const SIMPLE_HTML = `<!doctype html><html><head><style>body{margin:0;background:#123;color:#fff;font:48px sans-serif}
.box{width:100px;height:100px;background:tomato;animation:m 2s linear infinite}@keyframes m{to{transform:translateX(600px)}}</style></head>
<body><h1 id="title">Hello</h1><div class="box"></div><script>
document.getElementById('title').textContent = 'Script OK';
let parentAccess = 'none'; try { parentAccess = String(parent.document.title); } catch (e) { parentAccess = 'blocked'; }
let storage = 'none'; try { localStorage.setItem('x', '1'); storage = 'available'; } catch (e) { storage = 'blocked'; }
let cookie = 'none'; try { cookie = String(document.cookie); } catch (e) { cookie = 'blocked'; }
try { window.top.location.href = 'https://example.com/escaped'; } catch (e) { /* blocked by sandbox */ }
document.body.dataset.parent = parentAccess; document.body.dataset.storage = storage; document.body.dataset.cookie = cookie;
</script></body></html>`;

export function htmlFile(content = SIMPLE_HTML, name = 'animation.html') {
  return { name, mimeType: 'text/html', buffer: Buffer.from(content) };
}
