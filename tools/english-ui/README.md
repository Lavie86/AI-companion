# English UI across upstream updates

This fork translated the UI of [my-neuro](https://github.com/morettt/my-neuro) to English inside the source files.
Upstream keeps changing those files in Chinese. A plain `git merge upstream/main` would then conflict on every
translated line that upstream touched, and new upstream text would show up in Chinese.

The files here make those merges keep the English text.

## How to update

Double-click `update-from-upstream.bat` in the repository folder, or run:

```bat
node tools/english-ui/update-from-upstream.js
```

It checks that you have no uncommitted changes, adds the `upstream` remote if needed, sets up the merge driver,
fetches upstream and merges `upstream/main`. Then it lists the new Chinese lines that upstream added
(also saved to `tools/english-ui/last-report.txt`).

## How it works

`.gitattributes` assigns the `english-ui` merge driver to the `.js`, `.html`, `.py` and `.json` files under `live-2d/`,
plus `installer.py`, `update.py` and `full-hub/*.py`. When both sides changed one of those files, git runs
`merge-driver.js` with three versions: the merge base (upstream's old file), ours (English) and upstream's new file.

1. **Learn.** The merge base and our file differ mostly by translation. The driver diffs them, pairs each changed
   Chinese line with its English line, and records the pairs. Lines that we left in Chinese on purpose (emotion
   names, keys, text sent to the LLM) are recorded as unchanged.
2. **Translate.** It applies that translation to the merge base and to upstream's new file. A line that upstream
   left alone becomes exactly our line. A line that upstream edited keeps the English for the Chinese phrases we
   translated before. A phrase that our code still uses in Chinese somewhere is never translated.
3. **Merge.** It runs a normal 3-way merge (`git merge-file`) on the translated versions.

So lines that upstream did not touch always keep our version. A line where we changed code, not only text,
stays our change in the merge: if upstream also changed it, you get a normal conflict instead of losing either
side. If anything goes wrong, the driver falls back to the merge git would have done without it.

What it cannot do: translate text that is new in upstream. `report.js` lists those lines so you (or Claude Code)
can translate them. Some of them are data on purpose, so check before translating.

## Files

| File | What it does |
| --- | --- |
| `setup.js` | Registers the merge driver in `.git/config`. Needed once per clone. The update script runs it. |
| `merge-driver.js` | The merge driver git runs. |
| `lib.js` | Line pairing, phrase extraction and translation. |
| `report.js` | Lists new Chinese lines since a commit: `node tools/english-ui/report.js <commit>` (default `ORIG_HEAD`). |
| `update-from-upstream.js` | Fetch, merge and report in one step. |
| `test/english-ui.test.js` | Tests with real git merges: `node --test tools/english-ui/test/english-ui.test.js`. |

Without `setup.js`, git ignores the `merge=english-ui` attribute and does a plain merge, so nothing breaks.
