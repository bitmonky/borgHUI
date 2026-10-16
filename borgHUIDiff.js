/**
 * borgHUIDiff.js
 *
 * Computes the diff between an old file version and a new one.
 * Two kinds of diff:
 *
 *   - text-unified   : a unified diff string, for text/* content
 *   - binary-replaced: a stub record for anything else (v1 limitation)
 *
 * The output of diffForKind() is what gets stored inside a BorgFileDiff
 * memory body. It must be self-contained: reconstructing an older version
 * means applying the chain from head backwards, or (for binary-replaced)
 * fetching the ancestor shards if they still exist.
 *
 * No dependencies beyond node:fs, node:crypto, node:path.
 */

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_TEXT_BYTES = 2 * 1024 * 1024;   // 2 MB cap for inline unified diffs
const TEXT_MIME_HINTS = [
  'text/',
  'application/json',
  'application/javascript',
  'application/xml',
  'application/x-javascript',
  'application/x-httpd-php',
  'application/x-sh'
];

function isTextMime(mime) {
  if (!mime) return false;
  const m = String(mime).toLowerCase();
  return TEXT_MIME_HINTS.some(h => m.startsWith(h) || m.includes(h));
}

function sha256hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Minimal Myers-style unified diff. Good enough for source and prose.
 * Returns a string in the usual "@@ -a,b +c,d @@\n ..." format.
 */
function unifiedDiff(oldText, newText, oldName = 'a', newName = 'b', context = 3) {
  const a = oldText.split('\n');
  const b = newText.split('\n');

  // LCS via simple DP. Fine up to a few thousand lines.
  const n = a.length, m = b.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j]
        ? lcs[i + 1][j + 1] + 1
        : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  // Walk forward, emitting ops.
  const ops = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push({ t: ' ', v: a[i] }); i++; j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) { ops.push({ t: '-', v: a[i] }); i++; }
    else { ops.push({ t: '+', v: b[j] }); j++; }
  }
  while (i < n) { ops.push({ t: '-', v: a[i++] }); }
  while (j < m) { ops.push({ t: '+', v: b[j++] }); }

  // Group into hunks with context.
  const hunks = [];
  let k = 0;
  while (k < ops.length) {
    // Find next change.
    while (k < ops.length && ops[k].t === ' ') k++;
    if (k >= ops.length) break;

    const start = Math.max(0, k - context);
    let end = k;
    let seen = 0;
    while (end < ops.length) {
      if (ops[end].t === ' ') {
        seen++;
        if (seen > 2 * context) break;
      } else {
        seen = 0;
      }
      end++;
    }
    // Trim trailing context.
    let trimEnd = end;
    while (trimEnd > start && ops[trimEnd - 1].t === ' ') trimEnd--;

    hunks.push({ start, end: trimEnd, ops: ops.slice(start, trimEnd) });
    k = end;
  }

  if (hunks.length === 0) return '';   // no differences

  // Count lines in old/new up to each hunk start for the @@ header.
  let out = `--- ${oldName}\n+++ ${newName}\n`;
  for (const h of hunks) {
    let aStart = 1, bStart = 1;
    for (let x = 0; x < h.start; x++) {
      if (ops[x].t === ' ' || ops[x].t === '-') aStart++;
      if (ops[x].t === ' ' || ops[x].t === '+') bStart++;
    }
    let aCount = 0, bCount = 0;
    for (const op of h.ops) {
      if (op.t === ' ' || op.t === '-') aCount++;
      if (op.t === ' ' || op.t === '+') bCount++;
    }
    out += `@@ -${aStart},${aCount} +${bStart},${bCount} @@\n`;
    for (const op of h.ops) out += op.t + op.v + '\n';
  }
  return out;
}

/**
 * Text diff. Reads both files, emits unified diff plus a short summary
 * so the memory keyword extractor has something to work with.
 */
async function diffText(oldPath, newPath, oldName, newName) {
  const oldBuf = await fs.promises.readFile(oldPath);
  const newBuf = await fs.promises.readFile(newPath);

  const oldSize = oldBuf.length;
  const newSize = newBuf.length;

  if (oldSize > MAX_TEXT_BYTES || newSize > MAX_TEXT_BYTES) {
    return {
      kind: 'binary-replaced',
      reason: 'text-too-large',
      oldSize, newSize,
      oldHash: sha256hex(oldBuf),
      newHash: sha256hex(newBuf)
    };
  }

  const oldText = oldBuf.toString('utf8');
  const newText = newBuf.toString('utf8');
  const body = unifiedDiff(oldText, newText, oldName, newName);

  // Cheap line summary for search keywords.
  let added = 0, removed = 0;
  for (const line of body.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) added++;
    else if (line.startsWith('-') && !line.startsWith('---')) removed++;
  }

  return {
    kind: 'text-unified',
    oldSize, newSize,
    oldHash: sha256hex(oldBuf),
    newHash: sha256hex(newBuf),
    added, removed,
    diff: body
  };
}

/**
 * Binary stub. Real delta compression (rsync rolling hash) is a v2 concern.
 */
async function diffBinary(oldPath, newPath) {
  const [oldBuf, newBuf] = await Promise.all([
    fs.promises.readFile(oldPath),
    fs.promises.readFile(newPath)
  ]);
  return {
    kind: 'binary-replaced',
    oldSize: oldBuf.length,
    newSize: newBuf.length,
    oldHash: sha256hex(oldBuf),
    newHash: sha256hex(newBuf)
  };
}

/**
 * Dispatcher. Caller supplies the mime type of the *new* file and the two
 * on-disk paths. Returns a serializable object suitable for embedding in a
 * BorgFileDiff memory body.
 */
async function diffForKind(mime, oldPath, newPath, oldName = null, newName = null) {
  if (isTextMime(mime)) {
    return diffText(
      oldPath, newPath,
      oldName || path.basename(oldPath),
      newName || path.basename(newPath)
    );
  }
  return diffBinary(oldPath, newPath);
}

/**
 * Hand-built keyword weights for a diff, used when we skip the LLM.
 * Binary stubs and small text diffs go through this path.
 */
function makeDiffWeights(meta, extraWords = []) {
  const out = [];
  const seen = new Set();
  const push = (word, weight) => {
    if (!word) return;
    const w = String(word).toLowerCase().trim();
    if (w.length < 2 || seen.has(w)) return;
    seen.add(w);
    out.push({ word: w.slice(0, 45), weight });
  };

  push('borgfilediff', 9);
  push(meta.fileName, 8);
  push(meta.lineageID, 7);
  push(`v${meta.version}`, 7);
  push(meta.fileType, 3);

  for (const w of extraWords) push(w, 4);
  return { keyWords: out };
}

module.exports = {
  diffForKind,
  diffText,
  diffBinary,
  unifiedDiff,
  isTextMime,
  makeDiffWeights,
  sha256hex
};