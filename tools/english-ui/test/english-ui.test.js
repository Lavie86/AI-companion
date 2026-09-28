'use strict';
// Run with: node --test tools/english-ui/test/english-ui.test.js
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const lib = require('../lib');

const TOOL_DIR = path.join(__dirname, '..');
const TOOL_FILES = ['lib.js', 'merge-driver.js', 'setup.js', 'report.js', 'update-from-upstream.js'];

describe('phrases', () => {
    test('pairs each translated region of a line', () => {
        assert.deepEqual(
            lib.phrasePairs("log(`TTS模块: ${on ? '启用' : '禁用'}`);", "log(`TTS module: ${on ? 'on' : 'off'}`);"),
            [['模块', ' module'], ['启用', 'on'], ['禁用', 'off']]
        );
    });

    test('treats \\u escapes as whole characters', () => {
        assert.deepEqual(
            lib.phrasePairs("const t = '\\u5f55\\u97f3\\u4e2d...';", "const t = 'Recording...';"),
            [['\\u5f55\\u97f3\\u4e2d', 'Recording']]
        );
    });

    test('a phrase only matches as a whole phrase', () => {
        assert.equal(lib.matchesAt("x = '开心'", 5, '开'), false);
        assert.equal(lib.matchesAt("x = '开'", 5, '开'), true);
    });

    test('tells a pure translation from a line with a code change', () => {
        assert.equal(lib.isTranslationOnly("showToast('保存成功', 'success');", "showToast('Saved', 'success');"), true);
        assert.equal(lib.isTranslationOnly("showToast('保存成功');", "showToast('Saved'); retry();"), false);
        assert.equal(lib.isTranslationOnly('<b title="保存">保存</b>', '<b title="Save">Save</b>', true), true);
    });
});

describe('learn and translate', () => {
    const o = [
        "showToast('保存成功', 'success');",
        "console.log('调试信息');",
        "const EMOTIONS = ['开心', '生气'];",
        "showToast('加载失败', 'error');"
    ].join('\n');
    const a = [
        "showToast('Saved', 'success');",
        "console.log('调试信息');",
        "const EMOTIONS = ['开心', '生气'];",
        "showToast('Failed to load', 'error');"
    ].join('\n');

    test('the old upstream file translates to exactly our file', () => {
        const model = lib.learnFromTexts(o, a);
        assert.equal(lib.translateText(o, model), a);
    });

    test('an upstream edit on a translated line keeps the English text', () => {
        const model = lib.learnFromTexts(o, a);
        assert.equal(lib.translateLine("    showToast('保存成功', 'info');", model), "    showToast('Saved', 'info');");
    });

    test('text kept in Chinese on purpose is never translated', () => {
        const model = lib.learnFromTexts(o, a);
        assert.equal(lib.translateLine("const MORE = ['开心', '生气', '难过'];", model), "const MORE = ['开心', '生气', '难过'];");
    });
});

// ---------- real git merges ----------

function sh(cwd, args, options = {}) {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', ...options });
    if (r.error) throw r.error;
    return r;
}

function gitOk(cwd, args) {
    const r = sh(cwd, args);
    assert.equal(r.status, 0, `git ${args.join(' ')}:\n${r.stdout}\n${r.stderr}`);
    return r.stdout;
}

function write(dir, file, text) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
}

function read(dir, file) {
    return fs.readFileSync(path.join(dir, file), 'utf8');
}

function commitAll(dir, message) {
    gitOk(dir, ['add', '-A']);
    gitOk(dir, ['commit', '-q', '-m', message]);
    return gitOk(dir, ['rev-parse', 'HEAD']).trim();
}

// A repo with the tool, a Chinese base commit on "main" and an "upstream" branch.
function makeRepo(files) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'english-ui-test-'));
    gitOk(dir, ['init', '-q', '-b', 'main']);
    gitOk(dir, ['config', 'user.name', 'Test']);
    gitOk(dir, ['config', 'user.email', 'test@example.com']);
    gitOk(dir, ['config', 'commit.gpgsign', 'false']);
    for (const f of TOOL_FILES) write(dir, `tools/english-ui/${f}`, fs.readFileSync(path.join(TOOL_DIR, f), 'utf8'));
    write(dir, '.gitattributes', '/live-2d/**/*.js merge=english-ui\n/live-2d/**/*.html merge=english-ui\n/live-2d/**/*.py merge=english-ui\n');
    for (const [f, text] of Object.entries(files)) write(dir, f, text);
    commitAll(dir, 'upstream base');
    gitOk(dir, ['branch', 'upstream']);
    return dir;
}

function setup(dir) {
    const r = spawnSync(process.execPath, ['tools/english-ui/setup.js'], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
}

const BASE_JS = [
    'function save() {',
    "    showToast('保存成功', 'success');",
    '}',
    '',
    'function load() {',
    "    showToast('加载失败', 'error');",
    "    console.log('调试信息');",
    '}',
    '',
    "const EMOTIONS = ['开心', '生气'];",
    '',
    'module.exports = { save, load };',
    ''
].join('\n');

describe('merge driver', () => {
    test('carries our English into upstream changes', () => {
        const dir = makeRepo({ 'live-2d/main.js': BASE_JS });
        setup(dir);
        // ours: translate, plus a code change elsewhere
        write(dir, 'live-2d/main.js', BASE_JS
            .replace("'保存成功'", "'Saved'")
            .replace("'加载失败'", "'Failed to load'")
            .replace('module.exports = { save, load };', 'module.exports = { save, load, EMOTIONS };'));
        commitAll(dir, 'translate');
        // upstream: edit a translated line, add a new string, change data and a log line
        gitOk(dir, ['checkout', '-q', 'upstream']);
        write(dir, 'live-2d/main.js', BASE_JS
            .replace("showToast('保存成功', 'success');", "showToast('保存成功', 'info');")
            .replace("    console.log('调试信息');", "    showToast('删除失败', 'error');\n    console.log('调试信息', Date.now());")
            .replace("['开心', '生气']", "['生气', '开心']"));
        commitAll(dir, 'upstream change');
        gitOk(dir, ['checkout', '-q', 'main']);
        const before = gitOk(dir, ['rev-parse', 'HEAD']).trim();

        const merge = sh(dir, ['merge', '-q', '--no-edit', 'upstream']);
        assert.equal(merge.status, 0, merge.stdout + merge.stderr);
        assert.equal(read(dir, 'live-2d/main.js'), [
            'function save() {',
            "    showToast('Saved', 'info');",
            '}',
            '',
            'function load() {',
            "    showToast('Failed to load', 'error');",
            "    showToast('删除失败', 'error');",
            "    console.log('调试信息', Date.now());",
            '}',
            '',
            "const EMOTIONS = ['生气', '开心'];",
            '',
            'module.exports = { save, load, EMOTIONS };',
            ''
        ].join('\n'));

        const report = spawnSync(process.execPath, ['tools/english-ui/report.js', before], { cwd: dir, encoding: 'utf8' });
        assert.equal(report.status, 0, report.stderr);
        assert.match(report.stdout, /1 new line\(s\) with Chinese text/);
        assert.match(report.stdout, /7: showToast\('删除失败', 'error'\);/);
        assert.doesNotMatch(report.stdout, /调试信息/);
    });

    test('a real conflict stays a conflict, with both sides in English', () => {
        const dir = makeRepo({ 'live-2d/main.js': BASE_JS });
        setup(dir);
        write(dir, 'live-2d/main.js', BASE_JS
            .replace("'保存成功'", "'Saved'")
            .replace("showToast('加载失败', 'error');", "showToast('Failed to load', 'error'); retry();"));
        commitAll(dir, 'translate and change a line');
        gitOk(dir, ['checkout', '-q', 'upstream']);
        write(dir, 'live-2d/main.js', BASE_JS.replace("showToast('加载失败', 'error');", "showToast('加载失败', 'warning');"));
        commitAll(dir, 'upstream changes the same line');
        gitOk(dir, ['checkout', '-q', 'main']);

        const merge = sh(dir, ['merge', '-q', '--no-edit', 'upstream']);
        assert.notEqual(merge.status, 0);
        const text = read(dir, 'live-2d/main.js');
        assert.match(text, /<<<<<<< ours\n {4}showToast\('Failed to load', 'error'\); retry\(\);\n=======\n {4}showToast\('Failed to load', 'warning'\);\n>>>>>>> upstream/);
        assert.match(text, /showToast\('Saved', 'success'\);/);
    });

    test('without the setup, git does its usual merge', () => {
        const dir = makeRepo({ 'live-2d/main.js': BASE_JS });
        write(dir, 'live-2d/main.js', BASE_JS.replace("'保存成功'", "'Saved'"));
        commitAll(dir, 'translate');
        gitOk(dir, ['checkout', '-q', 'upstream']);
        write(dir, 'live-2d/main.js', BASE_JS.replace("showToast('保存成功', 'success');", "showToast('保存成功', 'info');"));
        commitAll(dir, 'upstream change');
        gitOk(dir, ['checkout', '-q', 'main']);
        assert.notEqual(sh(dir, ['merge', '-q', '--no-edit', 'upstream']).status, 0);
    });

    test('works for HTML and Python, and from a subfolder', () => {
        const html = '<div>\n    <button id="save" title="保存设置">保存</button>\n</div>\n';
        const py = "def status(ok):\n    return f'已连接到 {ok}' if ok else '未连接'\n";
        const dir = makeRepo({ 'live-2d/index.html': html, 'live-2d/webui/status.py': py });
        setup(dir);
        write(dir, 'live-2d/index.html', html.replace('title="保存设置">保存<', 'title="Save settings">Save<'));
        write(dir, 'live-2d/webui/status.py', py.replace("f'已连接到 {ok}'", "f'Connected to {ok}'").replace("'未连接'", "'Not connected'"));
        commitAll(dir, 'translate');
        gitOk(dir, ['checkout', '-q', 'upstream']);
        write(dir, 'live-2d/index.html', html.replace('<button id="save"', '<button id="save" class="primary"'));
        write(dir, 'live-2d/webui/status.py', py.replace('def status(ok):', 'def status(ok=None):').replace("if ok else", "if ok is not None else"));
        commitAll(dir, 'upstream change');
        gitOk(dir, ['checkout', '-q', 'main']);

        const merge = sh(path.join(dir, 'live-2d'), ['merge', '-q', '--no-edit', 'upstream']);
        assert.equal(merge.status, 0, merge.stdout + merge.stderr);
        assert.equal(read(dir, 'live-2d/index.html'), '<div>\n    <button id="save" class="primary" title="Save settings">Save</button>\n</div>\n');
        assert.equal(read(dir, 'live-2d/webui/status.py'), "def status(ok=None):\n    return f'Connected to {ok}' if ok is not None else 'Not connected'\n");
    });
});

describe('merge driver paths', () => {
    test('handles a path with spaces and Chinese characters', () => {
        const file = 'live-2d/plugins/我的 插件/index.js';
        const dir = makeRepo({ [file]: BASE_JS });
        setup(dir);
        write(dir, file, BASE_JS.replace("'保存成功'", "'Saved'"));
        commitAll(dir, 'translate');
        gitOk(dir, ['checkout', '-q', 'upstream']);
        write(dir, file, BASE_JS.replace("showToast('保存成功', 'success');", "showToast('保存成功', 'info');"));
        commitAll(dir, 'upstream change');
        gitOk(dir, ['checkout', '-q', 'main']);
        const merge = sh(dir, ['merge', '-q', '--no-edit', 'upstream']);
        assert.equal(merge.status, 0, merge.stdout + merge.stderr);
        assert.match(read(dir, file), /showToast\('Saved', 'info'\);/);
    });
});

describe('merge driver on HTML', () => {
    test('a translated HTML line that upstream also edited merges cleanly', () => {
        // The English reorders the words, so only the HTML-aware check sees a pure translation.
        const html = '<div>\n    <b>模型 (GPT) 设置</b><i>说明</i>\n</div>\n';
        const dir = makeRepo({ 'live-2d/page.html': html });
        setup(dir);
        write(dir, 'live-2d/page.html', html.replace('<b>模型 (GPT) 设置</b><i>说明</i>', '<b>Settings for the GPT model</b><i>Notes</i>'));
        commitAll(dir, 'translate');
        gitOk(dir, ['checkout', '-q', 'upstream']);
        write(dir, 'live-2d/page.html', html.replace('<b>模型 (GPT) 设置</b>', '<b class="x">模型 (GPT) 设置</b>'));
        commitAll(dir, 'upstream change');
        gitOk(dir, ['checkout', '-q', 'main']);
        const merge = sh(dir, ['merge', '-q', '--no-edit', 'upstream']);
        assert.equal(merge.status, 0, merge.stdout + merge.stderr);
        assert.match(read(dir, 'live-2d/page.html'), /<b class="x">.*<\/b><i>Notes<\/i>/);
    });
});

describe('update-from-upstream', () => {
    test('fetches, merges and reports new strings', () => {
        const dir = makeRepo({ 'live-2d/main.js': BASE_JS });
        write(dir, 'live-2d/main.js', BASE_JS.replace("'保存成功'", "'Saved'").replace("'加载失败'", "'Failed to load'"));
        commitAll(dir, 'translate');
        // a separate "upstream" repository with one new commit
        const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'english-ui-remote-'));
        gitOk(remote, ['init', '-q', '--bare']);
        gitOk(dir, ['push', '-q', remote, 'upstream:main']);
        gitOk(dir, ['checkout', '-q', 'upstream']);
        write(dir, 'live-2d/main.js', BASE_JS.replace("showToast('加载失败', 'error');", "showToast('加载失败', 'error', 5000);\n    showToast('请稍候', 'info');"));
        commitAll(dir, 'upstream change');
        gitOk(dir, ['push', '-q', remote, 'upstream:main']);
        gitOk(dir, ['checkout', '-q', 'main']);
        gitOk(dir, ['branch', '-D', 'upstream']);
        gitOk(dir, ['remote', 'add', 'upstream', remote]);

        const r = spawnSync(process.execPath, ['tools/english-ui/update-from-upstream.js'], { cwd: dir, encoding: 'utf8' });
        assert.equal(r.status, 0, r.stdout + r.stderr);
        assert.match(r.stdout, /1 new upstream commit\(s\)/);
        assert.match(r.stdout, /showToast\('请稍候', 'info'\);/);
        assert.match(read(dir, 'live-2d/main.js'), /showToast\('Failed to load', 'error', 5000\);/);
        assert.match(read(dir, 'live-2d/main.js'), /showToast\('Saved', 'success'\);/);

        const again = spawnSync(process.execPath, ['tools/english-ui/update-from-upstream.js'], { cwd: dir, encoding: 'utf8' });
        assert.equal(again.status, 0, again.stderr);
        assert.match(again.stdout, /Already up to date/);
    });

    test('refuses to run with uncommitted changes', () => {
        const dir = makeRepo({ 'live-2d/main.js': BASE_JS });
        write(dir, 'live-2d/main.js', BASE_JS + '// edit\n');
        const r = spawnSync(process.execPath, ['tools/english-ui/update-from-upstream.js'], { cwd: dir, encoding: 'utf8' });
        assert.equal(r.status, 1);
        assert.match(r.stderr, /uncommitted changes/);
    });
});
