/**
 * Puts the General Sans webfonts the page uses into web/fonts/, so the site serves them itself
 * and visitors' browsers never contact a third-party font host.
 *
 * Why the files aren't committed: General Sans is licensed under the ITF Free Font License,
 * which allows self-hosting on your own site but forbids redistributing the files through
 * public repositories. So they are fetched from Fontshare's official download at build time
 * (Vercel runs this as the build command) and on `npm start` locally, and git ignores them.
 * The license also forbids modifying them, so they are used exactly as shipped.
 *
 * Each file is checked against a pinned SHA-256. If Fontshare ships new versions, the check
 * fails with the new hashes; review them and update EXPECTED below.
 *
 * Usage: node scripts/fetch-fonts.mjs [--optional]
 *   --optional  warn instead of failing when the download fails (used by `npm start`, so the
 *               calculator still runs offline, falling back to system fonts).
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const OUT_DIR = join(ROOT, 'web', 'fonts');
const SOURCE = 'https://api.fontshare.com/v2/fonts/download/general-sans';
const ZIP_DIR = 'GeneralSans_Complete/Fonts/WEB/fonts/';
const MAX_ZIP_BYTES = 20 * 1024 * 1024;

/** weight → official file and its pinned hash */
const EXPECTED = {
  'GeneralSans-Light.woff2': '33bb7354c8e1e55ce4c1dbfb769820a639c1ff05052ff32a2ab0741e816a3f94',
  'GeneralSans-Regular.woff2': '1336dc6137440a94f87d883bcc3ee26bdbd580606d61e89e6e530757d9328886',
  'GeneralSans-Medium.woff2': '0168813e5da4bb7fcbffbe1305cc4932220772ff26c0488c5d62e28f579aa5ae',
};

const optional = process.argv.includes('--optional');
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

async function alreadyPresent() {
  try {
    for (const [name, hash] of Object.entries(EXPECTED)) {
      if (sha256(await readFile(join(OUT_DIR, name))) !== hash) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** Reads named entries from a zip using its central directory. Supports stored and deflated entries. */
function extract(zip, wanted) {
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('download is not a zip archive');
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  const found = new Map();
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) throw new Error('corrupt zip central directory');
    const method = zip.readUInt16LE(p + 10);
    const compressed = zip.readUInt32LE(p + 20);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const local = zip.readUInt32LE(p + 42);
    const name = zip.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (!name.startsWith(ZIP_DIR)) continue;
    const base = name.slice(ZIP_DIR.length);
    if (!wanted.includes(base)) continue;
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const data = zip.subarray(start, start + compressed);
    if (method === 0) found.set(base, Buffer.from(data));
    else if (method === 8) found.set(base, inflateRawSync(data));
    else throw new Error(`unsupported zip compression method ${method}`);
  }
  return found;
}

async function main() {
  if (await alreadyPresent()) return console.log('fonts: General Sans already in web/fonts');

  const res = await fetch(SOURCE, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`Fontshare download returned ${res.status}`);
  const zip = Buffer.from(await res.arrayBuffer());
  if (zip.length > MAX_ZIP_BYTES) throw new Error('Fontshare download is unexpectedly large');

  const files = extract(zip, Object.keys(EXPECTED));
  const problems = [];
  for (const [name, hash] of Object.entries(EXPECTED)) {
    const buf = files.get(name);
    if (!buf) problems.push(`${name}: missing from the download`);
    else if (sha256(buf) !== hash) problems.push(`${name}: hash ${sha256(buf)} does not match the pinned ${hash}`);
  }
  if (problems.length) throw new Error(`font check failed\n  ${problems.join('\n  ')}`);

  await mkdir(OUT_DIR, { recursive: true });
  for (const [name, buf] of files) {
    const tmp = join(OUT_DIR, `.${name}.tmp`);
    await writeFile(tmp, buf);
    await rename(tmp, join(OUT_DIR, name));
  }
  console.log(`fonts: wrote ${files.size} General Sans files to web/fonts`);
}

main().catch((err) => {
  if (optional) {
    console.warn(`fonts: ${err.message}. The calculator will use system fonts until this succeeds.`);
  } else {
    console.error(`fonts: ${err.message}`);
    process.exit(1);
  }
});
