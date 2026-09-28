#!/usr/bin/env node
'use strict';
// git merge driver that keeps our English UI text when merging upstream changes.
//
// git runs it as: node tools/english-ui/merge-driver.js %O %A %B %P
//   %O  merge base (upstream's old file, usually Chinese)
//   %A  our file (English); the merge result must be written here
//   %B  upstream's new file (Chinese)
//   %P  path of the file in the repository (only used in messages)
//
// It learns the translation from %O -> %A, applies it to both %O and %B, then runs a
// normal 3-way merge (git merge-file). Exit code 0 = merged cleanly, 1 = conflicts.
// Any problem falls back to the plain merge git would have done without this driver.

const fs = require('fs');
const os = require('os');
const path = require('path');
const lib = require('./lib');

const [baseFile, oursFile, theirsFile, rawPath = ''] = process.argv.slice(2);
// An older setup quoted %P twice, which left the quotes in the argument.
const repoPath = rawPath.replace(/^'(.*)'$/, '$1');
const label = repoPath || oursFile;

function mergeFile(base, theirs) {
    const r = lib.git(['merge-file', '-L', 'ours', '-L', 'base', '-L', 'upstream', oursFile, base, theirs]);
    if (r.status === null || r.status > 127) {
        throw new Error(`git merge-file failed for ${label}: ${r.stderr}`);
    }
    return r.status;
}

function run() {
    const o = lib.readText(baseFile);
    const a = lib.readText(oursFile);
    const b = lib.readText(theirsFile);
    if (lib.looksBinary(o + a + b) || !lib.hasCJK(o)) return mergeFile(baseFile, theirsFile);

    const model = lib.learn(o, a, lib.diffHunks(baseFile, oursFile), label);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'english-ui-merge-'));
    try {
        const base2 = path.join(dir, 'base');
        const theirs2 = path.join(dir, 'upstream');
        fs.writeFileSync(base2, lib.translateText(o, model));
        fs.writeFileSync(theirs2, lib.translateText(b, model));
        return mergeFile(base2, theirs2);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

let conflicts;
try {
    conflicts = run();
} catch (error) {
    process.stderr.write(`english-ui: ${error.message}\nenglish-ui: using a plain merge for ${label}\n`);
    try {
        conflicts = mergeFile(baseFile, theirsFile);
    } catch (plainError) {
        process.stderr.write(`english-ui: ${plainError.message}\n`);
        process.exit(2);
    }
}
process.exit(conflicts === 0 ? 0 : 1);
