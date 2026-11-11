import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../public/', import.meta.url));
const hash = createHash('sha256');
async function scan(dir) {
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) await scan(file);
    else if (file !== path.join(root, 'sw.js')) {
      hash.update(path.relative(root, file));
      hash.update('\0');
      hash.update(await readFile(file));
      hash.update('\0');
    }
  }
}
await scan(root);
const file = path.join(root, 'sw.js');
const source = (await readFile(file, 'utf8')).replace(/^\/\/ Build revision:.*\n/gm, '');
await writeFile(file, `// Build revision: ${hash.digest('hex')}\n${source}`);
