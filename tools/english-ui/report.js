#!/usr/bin/env node
'use strict';
// Lists Chinese text that a merge brought in: lines added since <since> that contain
// Chinese outside comments and debug output, in the files that use the english-ui
// merge driver. These are the new upstream strings that still need a translation.
// Lines made only of Chinese that the file already kept (emotion names and other
// data) are skipped. Some reported lines can still be data, so check each one.
//
// Usage: node tools/english-ui/report.js [<since>]     (default: ORIG_HEAD)
// The report is also saved to tools/english-ui/last-report.txt.

const fs = require('fs');
const path = require('path');
const lib = require('./lib');

const DEBUG_OUTPUT = /\bconsole\.(?:log|info|warn|error|debug)\(|\b(?:logger|logging)\.(?:debug|info|warning|warn|error|exception|critical)\(/;

function managedFiles(root, files) {
    const out = [];
    for (let i = 0; i < files.length; i += 200) {
        const batch = files.slice(i, i + 200);
        const text = lib.gitOk(['check-attr', '-z', 'merge', '--', ...batch], { cwd: root });
        const parts = text.split('\0');
        for (let k = 0; k + 2 < parts.length; k += 3) {
            if (parts[k + 2] === 'english-ui') out.push(parts[k]);
        }
    }
    return out;
}

const RUNS = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]+/g;
const IDEOGRAPH = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

// Chinese phrases the file already had in code before the merge. They were kept in
// Chinese on purpose (emotion names, keys, prompts), so a line made only of them is data.
function keptPhrases(root, since, file) {
    const kept = new Set();
    const r = lib.git(['show', `${since}:${file}`], { cwd: root });
    if (r.status !== 0) return kept;
    for (const line of r.stdout.split('\n')) {
        if (!lib.hasCJK(line) || lib.isCommentLine(line) || DEBUG_OUTPUT.test(line)) continue;
        for (const run of line.match(RUNS) || []) kept.add(run);
    }
    return kept;
}

function hasNewChinese(line, kept) {
    return (line.match(RUNS) || []).some(run => IDEOGRAPH.test(run) && !kept.has(run));
}

function addedLines(root, since, file) {
    const diff = lib.gitOk(['diff', '-U0', '--no-color', '--no-ext-diff', since, 'HEAD', '--', file], { cwd: root });
    const lines = [];
    let next = 0;
    for (const line of diff.split('\n')) {
        const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
        if (m) { next = Number(m[1]); continue; }
        if (line.startsWith('+++')) continue;
        if (line.startsWith('+')) lines.push({ number: next++, text: line.slice(1) });
    }
    return lines;
}

function report(since = 'ORIG_HEAD') {
    const root = lib.gitOk(['rev-parse', '--show-toplevel']).trim();
    const sinceCommit = lib.gitOk(['rev-parse', '--verify', `${since}^{commit}`], { cwd: root }).trim();
    const changed = lib.gitOk(['diff', '--name-only', '-z', '--diff-filter=AMR', sinceCommit, 'HEAD'], { cwd: root })
        .split('\0').filter(Boolean);
    const found = [];
    for (const file of managedFiles(root, changed)) {
        const kept = keptPhrases(root, sinceCommit, file);
        const hits = addedLines(root, sinceCommit, file).filter(l =>
            lib.hasCJK(l.text) && !lib.isCommentLine(l.text) && !DEBUG_OUTPUT.test(l.text) && hasNewChinese(l.text, kept));
        if (hits.length) found.push({ file, hits });
    }

    const out = [];
    const total = found.reduce((n, f) => n + f.hits.length, 0);
    if (!total) {
        out.push(`No new Chinese text since ${since}.`);
    } else {
        out.push(`${total} new line(s) with Chinese text since ${since} (${sinceCommit.slice(0, 7)}):`);
        for (const { file, hits } of found) {
            out.push('', `${file} (${hits.length})`);
            for (const h of hits) out.push(`  ${String(h.number).padStart(5)}: ${h.text.trim().slice(0, 160)}`);
        }
        out.push('', 'Translate the ones that are shown to you (labels, messages, logs). Leave data',
            'such as emotion names and text sent to the LLM. You can ask Claude Code to do it:',
            '"translate the new Chinese UI strings listed in tools/english-ui/last-report.txt".');
    }
    const text = out.join('\n') + '\n';
    fs.writeFileSync(path.join(root, 'tools', 'english-ui', 'last-report.txt'), text);
    return { total, text };
}

if (require.main === module) {
    try {
        process.stdout.write(report(process.argv[2]).text);
    } catch (error) {
        console.error(`Report failed: ${error.message}`);
        process.exit(1);
    }
}

module.exports = { report };
