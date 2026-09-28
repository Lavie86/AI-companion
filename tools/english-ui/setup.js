#!/usr/bin/env node
'use strict';
// One-time setup per clone: registers the "english-ui" merge driver in .git/config.
// .gitattributes (committed) says which files use it. Without this setup git ignores
// the attribute and does a plain merge, so nothing breaks, you just lose the help.
//
// Usage: node tools/english-ui/setup.js

const lib = require('./lib');

// git shell-quotes the placeholders itself, so they must not be quoted again here.
const DRIVER = 'node tools/english-ui/merge-driver.js %O %A %B %P';

function configure() {
    const root = lib.gitOk(['rev-parse', '--show-toplevel']).trim();
    lib.gitOk(['config', 'merge.english-ui.name', 'Keep the English UI text when merging upstream'], { cwd: root });
    lib.gitOk(['config', 'merge.english-ui.driver', DRIVER], { cwd: root });
    const attr = lib.gitOk(['check-attr', 'merge', '--', 'live-2d/main.js'], { cwd: root }).trim();
    if (!attr.endsWith(': english-ui')) {
        throw new Error('.gitattributes does not assign merge=english-ui to live-2d/main.js. Is it up to date?');
    }
    return root;
}

if (require.main === module) {
    try {
        const root = configure();
        console.log(`English UI merge driver is set up for ${root}`);
    } catch (error) {
        console.error(`Setup failed: ${error.message}`);
        process.exit(1);
    }
}

module.exports = { configure, DRIVER };
