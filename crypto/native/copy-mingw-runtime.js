// Copy the MinGW runtime that linked shearhash.node into this directory.
// LoadLibraryEx(LOAD_WITH_ALTERED_SEARCH_PATH) searches here before PATH.
// An older libgcc earlier on PATH (Rust, Android SDK) fails the load with
// "The specified procedure could not be found."
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const cc = process.argv[2] || 'gcc';
const listed = execFileSync('where', [cc], { encoding: 'utf8' });
const gcc = listed.split(/\r?\n/).map((s) => s.trim()).find((s) => s && fs.existsSync(s));
if (!gcc) {
  console.error('copy-mingw-runtime: ' + cc + ' not found');
  process.exit(1);
}
const dir = path.dirname(gcc);
const names = ['libstdc++-6.dll', 'libgcc_s_seh-1.dll', 'libwinpthread-1.dll'];
for (const name of names) {
  const src = path.join(dir, name);
  if (!fs.existsSync(src)) {
    console.error('copy-mingw-runtime: missing ' + src);
    process.exit(1);
  }
  fs.copyFileSync(src, path.join(here, name));
}
console.log('copy-mingw-runtime: ' + names.join(' ') + ' from ' + dir);
