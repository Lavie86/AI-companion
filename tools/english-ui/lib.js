'use strict';
// Shared code for keeping the English UI when merging upstream (Chinese) changes.
//
// The idea: the merge base (upstream's old file) and our file differ mostly by
// translation. Pairing their changed lines tells us how each Chinese line became
// English. Applying the same translation to upstream's old AND new file, then doing
// a normal 3-way merge, carries our English into upstream's new version.
// Lines that upstream did not change translate the same way on both sides, so our
// version always wins there, even when the translation is imperfect.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// CJK ideographs, or a \uXXXX escape of one (some upstream files escape Chinese).
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]|\\u(?:3[4-9a-fA-F]|[4-9][0-9a-fA-F])[0-9a-fA-F]{2}/;
// Characters that belong to a Chinese phrase: ideographs and full-width punctuation.
const RUN_CHAR = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;
const ESCAPE_AT = /^\\u(?:3[4-9a-fA-F]|[4-9][0-9a-fA-F])[0-9a-fA-F]{2}/;
const ESCAPE_BEFORE = /\\u(?:3[4-9a-fA-F]|[4-9][0-9a-fA-F])[0-9a-fA-F]{2}$/;

const DEBUG_OUTPUT = /\bconsole\.(?:log|info|warn|error|debug)\(|\b(?:logger|logging)\.(?:debug|info|warning|warn|error|exception|critical)\(/;
const MAX_CHAR_DIFF = 2000;      // longer lines are not split into phrases
const MIN_PAIR_SIMILARITY = 0.5; // code-token overlap needed to pair two lines

function hasCJK(s) {
    return CJK.test(s);
}

function keyOf(line) {
    return line.trim();
}

function readText(file) {
    return fs.readFileSync(file, 'utf8');
}

function looksBinary(text) {
    return text.includes('\u0000');
}

// ---------- line diff (git) ----------

// Changed regions between two files, as 0-based [start, length) ranges.
function diffHunks(fileA, fileB) {
    const r = spawnSync('git', [
        'diff', '--no-index', '--no-color', '--no-ext-diff', '--no-textconv',
        '--diff-algorithm=histogram', '-U0', '--', fileA, fileB
    ], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
    if (r.error) throw r.error;
    if (r.status !== 0 && r.status !== 1) throw new Error(`git diff failed: ${r.stderr}`);
    const hunks = [];
    for (const line of r.stdout.split('\n')) {
        const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
        if (!m) continue;
        const oLen = m[2] === undefined ? 1 : Number(m[2]);
        const aLen = m[4] === undefined ? 1 : Number(m[4]);
        hunks.push({
            oStart: oLen === 0 ? Number(m[1]) : Number(m[1]) - 1, oLen,
            aStart: aLen === 0 ? Number(m[3]) : Number(m[3]) - 1, aLen
        });
    }
    return hunks;
}

function withTempFiles(texts, fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'english-ui-'));
    try {
        const files = texts.map((t, i) => {
            const f = path.join(dir, `f${i}`);
            fs.writeFileSync(f, t);
            return f;
        });
        return fn(...files);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

function diffTextHunks(textA, textB) {
    return withTempFiles([textA, textB], diffHunks);
}

// ---------- pairing changed lines ----------

function codeTokens(s) {
    return s.match(/[A-Za-z_$][\w$]*|\d+|[^\s\w\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/g) || [];
}

function lcsLength(x, y) {
    if (!x.length || !y.length) return 0;
    let prev = new Array(y.length + 1).fill(0);
    let cur = new Array(y.length + 1).fill(0);
    for (let i = 1; i <= x.length; i++) {
        for (let j = 1; j <= y.length; j++) {
            cur[j] = x[i - 1] === y[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
        }
        [prev, cur] = [cur, prev];
    }
    return prev[y.length];
}

// How much of the Chinese line's code survives in the English line (0..1).
// Translation replaces the Chinese text but keeps the code around it.
function similarity(oLine, aLine) {
    const x = codeTokens(oLine.replace(/\\u[0-9a-fA-F]{4}/g, ' '));
    const y = codeTokens(aLine);
    if (!x.length) return hasCJK(oLine) && !hasCJK(aLine) ? MIN_PAIR_SIMILARITY : 0;
    return lcsLength(x, y) / x.length;
}

// Pair lines inside one changed region: best total similarity, order kept.
function alignRegion(oLines, aLines, hunk) {
    const n = hunk.oLen, m = hunk.aLen;
    if (!n || !m) return [];
    const sim = (i, j) => similarity(oLines[hunk.oStart + i], aLines[hunk.aStart + j]);
    if (n === m || n * m > 250000) {
        const pairs = [];
        for (let k = 0; k < Math.min(n, m); k++) {
            if (sim(k, k) >= MIN_PAIR_SIMILARITY) pairs.push([hunk.oStart + k, hunk.aStart + k]);
        }
        return pairs;
    }
    const score = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
    const move = Array.from({ length: n + 1 }, () => new Uint8Array(m + 1));
    for (let i = 1; i <= n; i++) {
        for (let j = 1; j <= m; j++) {
            let best = score[i - 1][j], how = 1;
            if (score[i][j - 1] > best) { best = score[i][j - 1]; how = 2; }
            const s = sim(i - 1, j - 1);
            if (s >= MIN_PAIR_SIMILARITY && score[i - 1][j - 1] + s > best) { best = score[i - 1][j - 1] + s; how = 3; }
            score[i][j] = best;
            move[i][j] = how;
        }
    }
    const pairs = [];
    for (let i = n, j = m; i > 0 && j > 0;) {
        if (move[i][j] === 3) { pairs.push([hunk.oStart + i - 1, hunk.aStart + j - 1]); i--; j--; }
        else if (move[i][j] === 1) i--;
        else j--;
    }
    return pairs.reverse();
}

function pairLines(oLines, aLines, hunks) {
    const pairs = [];
    for (const h of hunks) pairs.push(...alignRegion(oLines, aLines, h));
    return pairs;
}

// ---------- phrase pairs inside a line ----------

// Character diff of one Chinese line against its English version, as the list of
// replaced regions {del, ins}. Returns null for lines too long to diff.
// With mergeFragments, a region that only inserts or only deletes is joined to the
// next or previous region when at most 2 characters separate them. English word order
// can split one translation in two, for example "OpenAI 格式的" -> "OpenAI-compatible".
function diffRegions(oLine, aLine, mergeFragments = false) {
    if (oLine.length > MAX_CHAR_DIFF || aLine.length > MAX_CHAR_DIFF) return null;
    // \uXXXX escapes are compared as one unit, so their hex digits never match letters
    const o = oLine.match(/\\u[0-9a-fA-F]{4}|[\s\S]/g) || [];
    const a = aLine.match(/\\u[0-9a-fA-F]{4}|[\s\S]/g) || [];
    const n = o.length, m = a.length;
    const w = m + 1;
    const table = new Uint16Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            table[i * w + j] = o[i] === a[j]
                ? table[(i + 1) * w + j + 1] + 1
                : Math.max(table[(i + 1) * w + j], table[i * w + j + 1]);
        }
    }
    // alternating parts: {same} for matched text, {del, ins} for a replaced region
    const parts = [];
    let del = '', ins = '', same = '';
    const flushRegion = () => { if (del || ins) parts.push({ del, ins }); del = ''; ins = ''; };
    const flushSame = () => { if (same) parts.push({ same }); same = ''; };
    let i = 0, j = 0;
    while (i < n || j < m) {
        if (i < n && j < m && o[i] === a[j]) { flushRegion(); same += o[i]; i++; j++; continue; }
        flushSame();
        if (j < m && (i >= n || table[i * w + j + 1] >= table[(i + 1) * w + j])) { ins += a[j]; j++; }
        else { del += o[i]; i++; }
    }
    flushRegion();
    flushSame();
    for (let k = 0; mergeFragments && k + 2 < parts.length;) {
        const [x, gap, y] = [parts[k], parts[k + 1], parts[k + 2]];
        const joinable = x.same === undefined && y.same === undefined && gap.same.length <= 2
            && (!x.del || !x.ins || !y.del || !y.ins);
        if (joinable) parts.splice(k, 3, { del: x.del + gap.same + y.del, ins: x.ins + gap.same + y.ins });
        else k++;
    }
    return parts.filter(part => part.same === undefined);
}

// [chinese phrase, english phrase] for each translated region of a line pair.
function phrasePairs(oLine, aLine, mergeFragments = false) {
    return (diffRegions(oLine, aLine, mergeFragments) || [])
        .filter(r => hasCJK(r.del) && r.ins.trim())
        .map(r => [r.del, r.ins]);
}

// The line with the contents of its strings (and, in HTML, its text) removed.
function codeSkeleton(line, html) {
    let s = line.replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g, m => m[0] + m[0]);
    if (html) s = s.replace(/>[^<>]*</g, '><').replace(/^[^<>]*</, '<').replace(/>[^<>]*$/, '>');
    return s.replace(/\s+/g, ' ').trim();
}

const CODE_SIGNAL = /[;{}=<>|&$`\[\]]|[A-Za-z_$][\w$]*\(/;

// True when the English line is the Chinese line with only its text replaced.
// A line that also has a code change must stay visible to git as our change, so a
// conflicting upstream edit shows up as a conflict instead of silently winning.
function isTranslationOnly(oLine, aLine, html = false) {
    if (codeSkeleton(oLine, html) === codeSkeleton(aLine, html)) return true;
    // a line of plain text, for example inside a multi-line string
    const oCode = oLine.replace(/[\u3000-\u303f\u3400-\u9fff\uf900-\ufaff\uff00-\uffef]/g, '');
    if (!CODE_SIGNAL.test(oCode) && !CODE_SIGNAL.test(aLine)) return true;
    const regions = diffRegions(oLine, aLine);
    return regions !== null && regions.every(r =>
        [...r.del].some(ch => RUN_CHAR.test(ch)) || ESCAPE_AT.test(r.del) || (!r.del.trim() && !r.ins.trim()));
}

function isRunAt(line, index) {
    if (index < 0 || index >= line.length) return false;
    return RUN_CHAR.test(line[index]) || ESCAPE_AT.test(line.slice(index));
}

function isRunBefore(line, index) {
    if (index <= 0) return false;
    return RUN_CHAR.test(line[index - 1]) || ESCAPE_BEFORE.test(line.slice(Math.max(0, index - 6), index));
}

// A phrase only matches where it is a whole phrase: "开" must not match inside "开心".
function matchesAt(line, index, phrase) {
    if (!line.startsWith(phrase, index)) return false;
    if (isRunAt(phrase, 0) && isRunBefore(line, index)) return false;
    if (isRunBefore(phrase, phrase.length) && isRunAt(line, index + phrase.length)) return false;
    return true;
}

function isCommentLine(line) {
    const t = line.trim();
    return t.startsWith('//') || t.startsWith('/*') || t.startsWith('*') || t.startsWith('#') || t.startsWith('<!--');
}

// ---------- building and applying the translation ----------

function majority(counts) {
    let best, bestN = -1;
    for (const [value, n] of counts) if (n > bestN) { best = value; bestN = n; }
    return best;
}

function countInto(map, key, value) {
    if (!map.has(key)) map.set(key, new Map());
    const counts = map.get(key);
    counts.set(value, (counts.get(value) || 0) + 1);
}

// Learn the translation from upstream's old file (Chinese) and ours (English).
function learn(oText, aText, hunks, file = '') {
    const html = /\.html?$/i.test(file);
    const oLines = oText.split('\n');
    const aLines = aText.split('\n');
    const lineCounts = new Map();
    const phraseCounts = new Map();
    // Chinese lines we left alone map to themselves, so they stay exactly as ours.
    const changed = new Uint8Array(oLines.length);
    for (const h of hunks) changed.fill(1, h.oStart, h.oStart + h.oLen);
    oLines.forEach((line, i) => {
        if (!changed[i] && hasCJK(line) && !isCommentLine(line)) countInto(lineCounts, keyOf(line), keyOf(line));
    });
    for (const [i, j] of pairLines(oLines, aLines, hunks)) {
        const o = oLines[i], a = aLines[j];
        if (!hasCJK(o)) continue;
        const translationOnly = o === a || isTranslationOnly(o, a, html);
        if (translationOnly) countInto(lineCounts, keyOf(o), keyOf(a));
        if (o === a) continue;
        // Joining fragments is only safe when the line has no code change to join into.
        for (const [zh, en] of phrasePairs(o, a, translationOnly)) countInto(phraseCounts, zh, en);
    }
    const lines = new Map();
    for (const [k, counts] of lineCounts) lines.set(k, majority(counts));

    // A phrase that is still Chinese somewhere in our code was kept on purpose there
    // (data, a key, an LLM prompt), so it is not safe to translate it blindly.
    // Debug output (console.log, logger, print) is not data, so it does not count.
    const code = aLines.filter(l => hasCJK(l) && !isCommentLine(l) && !DEBUG_OUTPUT.test(l));
    const phrases = new Map();
    for (const [zh, counts] of phraseCounts) {
        if (code.some(l => findPhrase(l, zh) >= 0)) continue;
        phrases.set(zh, majority(counts));
    }
    return { lines, phrases: sortPhrases(phrases) };
}

function findPhrase(line, phrase) {
    for (let at = line.indexOf(phrase); at >= 0; at = line.indexOf(phrase, at + 1)) {
        if (matchesAt(line, at, phrase)) return at;
    }
    return -1;
}

// Index phrases by first character, longest first, for a fast left-to-right scan.
function sortPhrases(map) {
    const index = new Map();
    for (const entry of [...map.entries()].sort((x, y) => y[0].length - x[0].length)) {
        const first = entry[0][0];
        if (!index.has(first)) index.set(first, []);
        index.get(first).push(entry);
    }
    return index;
}

function translateLine(line, model) {
    if (!hasCJK(line) || isCommentLine(line)) return line;
    const key = keyOf(line);
    if (model.lines.has(key)) {
        const lead = line.match(/^\s*/)[0];
        const trail = line.slice(lead.length + key.length);
        return lead + model.lines.get(key) + trail;
    }
    let out = '';
    for (let i = 0; i < line.length;) {
        const candidates = model.phrases.get(line[i]);
        const hit = candidates && candidates.find(([zh]) => matchesAt(line, i, zh));
        if (hit) { out += hit[1]; i += hit[0].length; }
        else { out += line[i]; i++; }
    }
    return out;
}

function translateText(text, model) {
    return text.split('\n').map(l => translateLine(l, model)).join('\n');
}

function learnFromTexts(oText, aText, file = '') {
    return learn(oText, aText, diffTextHunks(oText, aText), file);
}

// ---------- git helpers ----------

function git(args, options = {}) {
    const r = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, ...options });
    if (r.error) throw r.error;
    return r;
}

function gitOk(args, options) {
    const r = git(args, options);
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed:\n${r.stderr || r.stdout}`);
    return r.stdout;
}

module.exports = {
    CJK, hasCJK, keyOf, readText, looksBinary, isCommentLine,
    diffHunks, diffTextHunks, pairLines, similarity, diffRegions, phrasePairs, codeSkeleton, isTranslationOnly, matchesAt,
    learn, learnFromTexts, translateLine, translateText, git, gitOk
};
