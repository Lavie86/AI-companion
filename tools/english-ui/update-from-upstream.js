#!/usr/bin/env node
'use strict';
// Merge the latest upstream my-neuro into the current branch, keeping the English UI.
//
// Usage: node tools/english-ui/update-from-upstream.js [branch]   (default: main)
// update-from-upstream.bat in the repository folder runs this.
//
// Steps: check for uncommitted changes, add the "upstream" remote if missing, set up
// the merge driver, fetch, merge upstream/<branch>, then list new Chinese strings.

const fs = require('fs');
const path = require('path');
const lib = require('./lib');
const { configure } = require('./setup');
const { report } = require('./report');

const UPSTREAM_URL = 'https://github.com/morettt/my-neuro';

function say(text = '') {
    process.stdout.write(`${text}\n`);
}

function fail(text) {
    process.stderr.write(`\n${text}\n`);
    process.exit(1);
}

function main() {
    const branch = process.argv[2] || 'main';
    const root = lib.gitOk(['rev-parse', '--show-toplevel']).trim();
    const gitDir = path.resolve(root, lib.gitOk(['rev-parse', '--git-dir'], { cwd: root }).trim());
    const git = (args, options = {}) => lib.git(args, { cwd: root, ...options });

    if (fs.existsSync(path.join(gitDir, 'MERGE_HEAD'))) {
        fail('A merge is already in progress. Finish it (fix the files, then "git commit") or undo it with "git merge --abort".');
    }
    const dirty = lib.gitOk(['status', '--porcelain', '--untracked-files=no'], { cwd: root }).trim();
    if (dirty) {
        fail(`You have uncommitted changes:\n${dirty}\n\nCommit them first (or "git stash" them), then run this again.`);
    }

    if (git(['remote', 'get-url', 'upstream']).status !== 0) {
        say(`Adding the upstream remote: ${UPSTREAM_URL}`);
        lib.gitOk(['remote', 'add', 'upstream', UPSTREAM_URL], { cwd: root });
    }
    configure();

    say(`Fetching upstream/${branch} ...`);
    if (git(['fetch', 'upstream', branch], { stdio: 'inherit' }).status !== 0) fail('git fetch failed. Check your internet connection.');

    const target = `upstream/${branch}`;
    const behind = Number(lib.gitOk(['rev-list', '--count', `HEAD..${target}`], { cwd: root }).trim());
    if (!behind) {
        say(`Already up to date with ${target}.`);
        return;
    }
    say(`${behind} new upstream commit(s). Merging ${target} ...`);
    const before = lib.gitOk(['rev-parse', 'HEAD'], { cwd: root }).trim();
    const merged = git(['merge', '--no-edit', '-m', `Merge upstream my-neuro (${target})`, target], { stdio: 'inherit' });

    if (merged.status !== 0) {
        const conflicted = lib.gitOk(['diff', '--name-only', '--diff-filter=U'], { cwd: root }).trim();
        fail([
            'The merge stopped because both sides changed the same lines in:',
            conflicted || '(see "git status")',
            '',
            'Open each file and look for <<<<<<< ours / ======= / >>>>>>> upstream.',
            'Upstream\'s side is already translated where the text was translated before.',
            'Keep what you want, delete the markers, then run:',
            '  git add <file>',
            '  git commit --no-edit',
            `  node tools/english-ui/report.js ${before.slice(0, 7)}`,
            'To undo the whole merge instead: git merge --abort'
        ].join('\n'));
    }

    say('');
    say(report(before).text.trimEnd());
    const changed = lib.gitOk(['diff', '--name-only', before, 'HEAD'], { cwd: root }).split('\n');
    say('');
    say('Next steps:');
    if (changed.some(f => /^live-2d\/package(-lock)?\.json$/.test(f))) say('  - live-2d/package.json changed: run "npm install" in live-2d.');
    if (changed.some(f => /(^|\/)requirements\.txt$/.test(f))) say('  - requirements.txt changed: install the new Python packages into env.');
    say('  - Run the tests (see START_HERE.md), start the app and check that it works.');
    say('  - Then push: git push');
}

try {
    main();
} catch (error) {
    fail(error.message);
}
