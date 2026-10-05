// Compiles src/slideshow.ts and inlines it into src/template.html -> slideshow.html
// Setup (once):  npm install
// Build once:    npm run build      (or: node build.mjs)
// Watch mode:    npm run watch      (or: node build.mjs --watch) - rebuilds when a file in src/ is saved
//
// The Google Maps API key is kept out of the source. Put it, on a line by itself, in a
// file named apikey.txt next to this script. That file and the built slideshow.html are
// git-ignored, so the key never reaches the repository.
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, watch, writeFileSync } from 'node:fs';

const SRC_DIR = 'src';
const KEY_FILE = 'apikey.txt';
const KEY_DECLARATION = "const GOOGLE_MAPS_API_KEY = 'YOUR_API_KEY_HERE';";
const DEBOUNCE_MS = 200; // editors often write a file in several steps

function build() {
  execSync('npx tsc -p .', { stdio: 'inherit' });
  let js = readFileSync('build/slideshow.js', 'utf8');
  rmSync('build', { recursive: true, force: true });

  if (!js.includes(KEY_DECLARATION)) {
    throw new Error('Could not find the GOOGLE_MAPS_API_KEY declaration in the compiled script. Was it renamed in src/slideshow.ts?');
  }
  const key = existsSync(KEY_FILE) ? readFileSync(KEY_FILE, 'utf8').trim() : '';
  if (key && !/^[\w-]+$/.test(key)) {
    throw new Error(`${KEY_FILE} should contain only the API key (letters, digits, - and _).`);
  }
  if (key) {
    // Replace only the declaration; the script also compares against the placeholder text.
    js = js.replace(KEY_DECLARATION, () => `const GOOGLE_MAPS_API_KEY = ${JSON.stringify(key)};`);
  }

  const html = readFileSync(`${SRC_DIR}/template.html`, 'utf8').replace('/*__SCRIPT__*/', () => js);
  writeFileSync('slideshow.html', html);
  console.log(key
    ? 'Built slideshow.html with your API key. Do not share or commit this file.'
    : `Built slideshow.html WITHOUT an API key (no ${KEY_FILE} found); the map will show a "no key" message.`);
}

/** Builds without letting a failure (e.g. a type error) end watch mode. */
function tryBuild() {
  try {
    build();
    return true;
  } catch (err) {
    // tsc has already printed its own errors; show anything else.
    if (!(err && typeof err === 'object' && 'status' in err)) console.error(err instanceof Error ? err.message : err);
    console.error('Build failed. slideshow.html was left unchanged.');
    return false;
  }
}

if (process.argv.includes('--watch')) {
  tryBuild();
  console.log(`Watching ${SRC_DIR}/ for changes. Press Ctrl+C to stop.`);
  let timer;
  watch(SRC_DIR, (_event, filename) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      console.log(`\n[${new Date().toLocaleTimeString()}] ${filename ?? 'A source file'} changed, rebuilding...`);
      tryBuild();
    }, DEBOUNCE_MS);
  });
} else if (!tryBuild()) {
  process.exitCode = 1;
}
