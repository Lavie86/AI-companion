# AI Companion (a my-neuro fork)

This repository is a fork of [morettt/my-neuro](https://github.com/morettt/my-neuro) (MIT license).
my-neuro is a Neuro-sama style desktop companion: a Live2D (or VRM) pet on your screen that listens,
talks back with a cloned voice, remembers you, and can use tools on your PC.

The fork starts from upstream commit `1cc55ab` (2026-09-27) and keeps the full upstream history,
so you can merge new upstream versions later (see [Updating](#updating)).

The upstream docs are mostly in Chinese. This file covers what you need in English.

## What this fork changes

| Change | Why | Where |
| --- | --- | --- |
| Speech recognition understands English | Upstream used `paraformer-zh`, a Chinese-only model. The default is now SenseVoice (English, Chinese, Japanese, Korean, Cantonese). | `full-hub/asr_api.py` |
| The default character talks in English | The persona prompt, TTS language, greeting and subtitle label were Chinese. | `live-2d/config.json` |
| PC control with Windows-MCP | She can see windows, click, type, open apps and run PowerShell through [Windows-MCP](https://github.com/CursorTouch/Windows-MCP). | `live-2d/mcp/mcp_config.json` |
| "Ask me first" approval gate | Upstream ran every tool at once, even AI-written Python. Now risky tools show a dialog first. | `live-2d/js/ai/tool-approval.js`, `live-2d/tool_safety.json` |
| Security fixes in two plugins | `pc-control` and `code-executor` pasted AI text into Python code and shell commands, so text on a web page could run code. | `live-2d/plugins/built-in/` |
| MCP client fixes | Screenshots from MCP tools were dropped. On Windows, stopped servers kept running (after a slow start and after closing the app). The client skipped a required handshake message. | `live-2d/js/ai/mcp-*.js` |
| The installer and updater keep your changes | Upstream's installer and `一键更新live-2d.bat` delete `live-2d` and unpack the release zip. In a git checkout they now skip that. | `full-hub/Batch_Download.py`, `update.py` |

Each change is its own commit, and each commit message explains the details.

## What you need

- Windows 10 or 11.
- A folder path with only English letters, no spaces and no brackets, for example `D:\ai-companion`.
- For local voice (the TTS voice): an NVIDIA GPU with about 5 GB of free VRAM. Without one, use a cloud TTS in the WebUI.
- For local speech recognition: 16 GB RAM is recommended, and a microphone.
- [Git](https://git-scm.com/download/win), [Python 3](https://www.python.org/downloads/windows/) (only to run the installer), and [Node.js 20 or newer](https://nodejs.org/).
- [uv](https://docs.astral.sh/uv/), which runs Windows-MCP.
- An API key for an OpenAI-compatible LLM that supports tool calling. For her to see your screen, the model also needs image input.
  Examples: OpenAI (`https://api.openai.com/v1`), OpenRouter (`https://openrouter.ai/api/v1`, which has many models behind one key),
  or a local server such as Ollama (`http://localhost:11434/v1`) or LM Studio (`http://localhost:1234/v1`).
  Small local models are often bad at tool calling.

## First-time setup

1. **Get the code.**

   ```bat
   git clone https://github.com/Lavie86/AI-companion D:\ai-companion
   cd /d D:\ai-companion
   git checkout main
   ```

2. **Run the installer.** It downloads a ready Python environment into `env\` (about 3.6 GB) and the models.

   ```bat
   python installer.py
   ```

   Pick the parts you want: ASR (speech recognition, about 2 GB plus about 1 GB for SenseVoice) and TTS (voice, about 4 GB) are the important ones.
   You can leave Live2D checked. In this fork it does not replace your `live-2d` folder.
   If a download fails, read `installer.log` in the same folder.

3. **Install the desktop app's Node packages.**

   ```bat
   cd live-2d
   npm install
   cd ..
   ```

4. **Install uv and warm up Windows-MCP.** The first run downloads Python 3.14 and the Windows-MCP packages, which can take a few minutes.

   ```bat
   winget install --id=astral-sh.uv -e
   ```

   Open a new terminal (so it sees uv), then run the line below. When it stops printing and waits, press `Ctrl+C`.

   ```bat
   uvx windows-mcp@0.8.6 serve
   ```

5. **Open the control panel.** Double-click `启动 WebUI 控制面板.bat` ("start WebUI control panel") in the repository folder.
   It opens a page at `http://localhost:<port>` in your browser. Use the language switch in the top-right corner to change the page to English.

6. **Add your LLM.** Some of these buttons are not translated yet, so the Chinese label is in brackets.
   1. Open the **LLM Config** tab, then click **Add** (添加).
   2. Enter a name, your **API Key** and the **API URL** (the `.../v1` address).
   3. Click **Fetch from API** (从 API 获取) to load the models, or add a model name by hand (添加模型).
   4. Turn on **Enabled** (启用), then click **Save Config** (top right).
   5. Open the **Features** tab, pick your model as the chat model (对话模型), and click **Save Config** again.
      The same tab has **Enable MCP Tools** (on in this fork) and **Text Input Box**, if you want to type instead of talk.

7. **Start everything.** On the **Launch** tab, click **Start all** (一键启动). It starts ASR, TTS and the other services, then the pet.
   You can also start the ASR and TTS cards first and then **Live2D Pet** by hand.

8. **Talk to her.** Speak into your microphone, or type in the text box.
   When she wants to click, type, open something or run code, a dialog asks you first.

## PC control and the approval dialog

Windows-MCP gives the AI real control of your PC. Its own README warns that it has full system access.
So every tool call goes through the approval gate first, and the rules are in `live-2d/tool_safety.json`:

- **`auto_approve`**: runs without asking. This fork lists only read-only or app-internal tools here:
  memory, diary, schedule, music, web search, screenshots, and the Windows-MCP `Screenshot`, `Snapshot`, `DisplayInventory`, `Wait` and `WaitFor` tools.
- **Everything else asks.** That includes clicks, typing, opening apps and web pages, and any new plugin or MCP tool you add later.
  The dialog has **Deny** (the default), **Allow once** and **Allow for this session**.
- **`always_ask`**: asks every time, without the "for this session" option. This covers PowerShell, FileSystem, Process, Clipboard, running AI-written Python and installing packages.
- **`blocked`**: never runs.
- No answer within `timeout_seconds` (120 by default) counts as **Deny**. Closing the dialog also counts as **Deny**.

Plugin tools are listed by name (`click_mouse`). MCP tools are listed as `mcp:<server>/<tool>` (`mcp:windows-mcp/Click`),
and `mcp:windows-mcp/*` matches all tools of that server. The file is read again on every tool call, so edits apply right away.

Other settings, in `live-2d/mcp/mcp_config.json`:

- Windows-MCP is pinned to version `0.8.6`, so a new release cannot change what runs on your PC without you choosing it.
  To upgrade, change the version in `args` and warm it up again (step 4).
- `WINDOWS_MCP_EXCLUDE_TOOLS` removes the `Registry` tool. Add more names with commas, for example `Registry,PowerShell`.
- `ANONYMIZED_TELEMETRY` is `false`, so Windows-MCP does not send its anonymous usage statistics.
- To turn Windows-MCP off, rename the key `windows-mcp` to `windows-mcp_disabled`.
  To turn off all MCP servers, set `mcp.enabled` to `false` in `live-2d/config.json`.

Good habits:

- Run the app as a normal Windows user, not as administrator.
- Only allow actions that you asked for. Text on web pages, in games, in chat or on your screen can trick the AI into asking for something harmful.
- If you use the Bilibili live-stream feature, remember that viewers' chat messages reach the AI too.
- Windows-MCP works best when Windows uses English as its display language. If Windows uses another language and the `App` tool misbehaves, add `App` to `WINDOWS_MCP_EXCLUDE_TOOLS`.

## Speech recognition settings

The ASR server reads two environment variables:

| Variable | Values | Default |
| --- | --- | --- |
| `MY_NEURO_ASR_MODEL` | `sensevoice`, or `paraformer-zh` for the upstream Chinese model (supports `full-hub/hotwords.txt`) | `sensevoice` |
| `MY_NEURO_ASR_LANGUAGE` | `auto`, `en`, `zh`, `ja`, `ko`, `yue` (SenseVoice only) | `auto` |

If you only speak English, set the language to `en`, so short phrases are not mistaken for another language:

```bat
setx MY_NEURO_ASR_LANGUAGE en
```

`setx` applies to programs started after it, so close and reopen the control panel.

If ASR fails to start and says the SenseVoice model is not registered, the Python environment has an old FunASR. Update it:

```bat
env\python.exe -m pip install -U "funasr>=1.1.3"
```

## Her personality and voice

- The personality prompt is in `live-2d/config.json` under `llm.system_prompt`. You can also edit it in the WebUI.
  Keep the emotion tags such as `<开心>` exactly as written: the app reads those Chinese tags to change her facial expression.
- The default TTS voice is a GPT-SoVITS model trained to sound like Neuro-sama.
  That is fine for private use. Use your own voice model before you stream or share anything: the WebUI has a **Voice Clone** tab for GPT-SoVITS.
- The default character is Feiniu ("fake neuro"). You can switch to another Live2D or VRM model in the WebUI.

## Updating

**Do not use `一键更新live-2d.bat`.** It replaces the whole `live-2d` folder with the upstream release and deletes your changes.
In this fork it refuses to run in a git checkout. Use git instead:

```bat
git pull
```

To get new upstream versions, merge them in:

```bat
git remote add upstream https://github.com/morettt/my-neuro
git fetch upstream
git merge upstream/main
```

You only need `git remote add` once. If git reports conflicts, resolve them, then commit.
After a merge, run `npm install` in `live-2d` again, and run the tests below.

## Tests

The fork's changes have tests. The JavaScript tests use Node's built-in test runner:

```bat
cd live-2d
node --test js/ai/tool-approval.test.js js/ai/tool-executor.test.js js/services/tool-approval-dialog.test.js js/ai/mcp-result.test.js js/ai/mcp-stdio-transport.test.js plugins/built-in/code-executor/tests/code-executor.test.js plugins/built-in/pc-control/tests/pc-control.test.js
```

The ASR tests use pytest and replace the real model with a fake, so they run fast:

```bat
env\python.exe -m pip install pytest httpx
env\python.exe -m pytest full-hub/tests -q
```

## What was and was not tested

The changes were built and tested on Linux, not on a Windows PC.

- **Tested:** the approval gate and dialog logic (29 unit tests), the MCP client against a FastMCP 4.0.5 server (the framework Windows-MCP 0.8.6 uses),
  the plugin fixes (including an attack that ran code through the old `pc-control` plugin), the ASR model switch with a fake model,
  and the installer and updater guards. The tests for the fixes fail against the upstream code.
- **Not tested:** the full Electron app on Windows, the native approval dialog on screen, Windows-MCP itself (it needs Windows),
  and the real SenseVoice model weights (the build sandbox could not download them).
  If something breaks on the first run, check `live-2d/runtime.log` and the logs on the **Launch** tab.

## Known limits

- Parts of the WebUI, some log messages and the docs are still in Chinese.
- The BERT "smart screenshot" classifier (`3.bert.bat`, off by default) comes from the Chinese upstream (its labels are Chinese) and probably works poorly on English. Leave it off.
- The local ASR and BERT servers listen on all network interfaces (`0.0.0.0`), as they do upstream.
  Other devices on your network can reach them unless Windows Firewall blocks them.
- The pet window runs with Node.js integration turned on (upstream design), so a bug that shows untrusted HTML in the window could give that HTML access to your PC.

## Credits

- [my-neuro](https://github.com/morettt/my-neuro) by morettt/xxxiu and contributors, MIT license (see `LICENSE`).
- [Windows-MCP](https://github.com/CursorTouch/Windows-MCP) by CursorTouch, MIT license.
- [SenseVoice](https://github.com/FunAudioLLM/SenseVoice) and [FunASR](https://github.com/modelscope/FunASR). Check the model card for the model license.
- [GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS), MIT license.
