# Handoff: AI Companion, and swapping the Live2D avatar for an E-mote one

Written by the cloud Claude Code session that did the setup so far (2026-09-29), for the local session on the user's PC.
Everything below was read in the code or seen in the user's logs unless it says **not verified** or **research this**. Every file path, name and command in it was fact-checked against `main` at `18113c3` by independent agents (220 claims, 17 corrections applied).

## 1. Goal and status

The user wants her avatar to be an **E-mote** model (M2 Co.'s 2D animation system, used in visual novels) instead of Live2D.

Status: **nothing is built yet.** Only feasibility research was done (section 9). The user has not named a model yet.
The plan agreed with the user:

1. **Feasibility test first:** a small test page that loads the user's E-mote model with the FreeMote SDK's WebGL engine inside Electron, run on the user's PC.
2. **If it works, an E-mote avatar driver** (section 5 has the interface):
   - show the model, emotions, lip sync, blinking, looking at the mouse,
   - models from an `emote` folder listed in the model pickers.
3. **Then polish:** dragging, resizing, settings.

## 2. Repository

- **Repo:** https://github.com/Lavie86/AI-companion. It is a fork of [morettt/my-neuro](https://github.com/morettt/my-neuro) (MIT), a Chinese Neuro-sama-style desktop companion.
- **Branches:**
  - **`main`** is the default branch and is current. Latest: `18113c3`, the merge of PR #3.
  - The cloud session worked on `claude/ai-pc-companion-research-iqohyz`, which now points at the same commit as `main`.
  - PRs #1 to #3 were merged with merge commits.
- **User's local clone:** `C:\Users\tbe00\my-neuro\AI-companion`.
- **`START_HERE.md`** is the English guide the cloud session wrote: setup, settings, tests, updating, known limits. Read it first.
- **Upstream updates:**
  - `update-from-upstream.bat` (or `node tools/english-ui/update-from-upstream.js`) merges `upstream/main`.
  - It uses a custom git merge driver (`tools/english-ui/`, registered by `tools/english-ui/setup.js`, assigned in `.gitattributes`). The driver keeps the English translations when upstream edits the same Chinese lines.
  - New UI text should be written in English.
- **Do not commit** `live-2d/config.json` from the user's PC. It holds their API key and settings.
- **Upstream secrets:** upstream committed other people's API keys, in `live-2d/config.json` (`cloud.volcengine_tts`, `cloud.aliyun_tts`) and `live-2d/plugins/built-in/minecraft/plugin_config.json` (`api_key`). The user was told not to use them. They are still in the repo.

## 3. Build and run on Windows

From `START_HERE.md` ("First-time setup"). The user has already done these steps:

1. `python installer.py` in the repo folder.
   - It downloads a ready Python environment into `env\` (~3.6 GB, from modelscope.cn, slow outside China, no resume) and the models into `full-hub\` (ASR, TTS, BERT).
   - In a git checkout it does not replace `live-2d`.
2. `cd live-2d && npm install`. This installs Electron 28 and the other packages.
3. `winget install --id=astral-sh.uv -e`, then `uvx windows-mcp@0.8.6 serve` once to warm up Windows-MCP (PC control).
4. Double-click **`启动 WebUI 控制面板.bat`** in the repo folder.
   - It starts the Flask WebUI with `env\python.exe` and opens `http://localhost:<port>`.
   - The port is random and changes on every launch (`find_free_port()` in `webui/utils.py`). Read it from the console line `访问地址：http://localhost:<port>` or from the browser tab.
   - Since commit `cfc66dc` the bat runs `pip install flask requests` if either import fails. The installer's environment has no Flask; it does have requests.
5. In the WebUI **Launch** tab, **Start all**, or start **Live2D Pet** by itself.
   - The WebUI starts the pet with `live-2d/go.bat` (`webui/service_controller.py`), which runs `node .\node_modules\electron\cli.js .`.

Other ways to run:
- **The pet directly:** `cd live-2d` then `npm start` (`electron .`, entry `main.js`), or `go.bat`.
- **The newer Electron control panel:** `npm run control` (`electron control-main.js`, `control.html`). The English docs only describe the WebUI.
- **Services:** root bats `1.ASR.bat` (FunASR/SenseVoice), `2.TTS.bat` (GPT-SoVITS `api.py` on port 5000 with the Neuro voice), `3.bert.bat`, and others.

Logs and debugging:
- The pet's app log is `live-2d/runtime.log`. It holds only `logToTerminal()` and `logToolAction()` output (both in `js/api-utils.js`; tool lines are tagged `[TOOL]`). The WebUI empties it each time it starts the pet.
- `console.log` does not reach any file, and there is no DevTools shortcut in `main.js`. Add one locally if you need the renderer console.

Tests (Node's runner; the Bilibili test needs `ws`, which `npm install` provides):
```bat
cd live-2d
node --test js/ai/tool-approval.test.js js/ai/tool-executor.test.js js/services/tool-approval-dialog.test.js js/ai/mcp-result.test.js js/ai/mcp-stdio-transport.test.js js/ai/reasoning-request.test.js js/live/bilibili-live.test.js js/ui/chat-box-placement.test.js plugins/built-in/code-executor/tests/code-executor.test.js plugins/built-in/memos/tests/backend-embedding-sync.test.js plugins/built-in/pc-control/tests/pc-control.test.js
```
63 tests, all passing as of `18113c3`. Also `node --test tools/english-ui/test/english-ui.test.js` (17 tests).

## 4. Tech stack

- **Pet app:** Electron 28 (`live-2d/main.js` is the main process, `index.html` + `app.js` the renderer).
  - The renderer has **Node integration on** and uses `require()` directly.
  - The window is transparent and always on top. It **spans all monitors**: `computePetWindowBounds` / `applyPetUnionBounds` in `main.js`, controlled by `ui.screen_extend`. On the user's PC the stage is 4694x1095 CSS px.
  - Clicks pass through except over the model and the UI, via `set-ignore-mouse-events` IPC.
- **Live2D:** PixiJS 6.5.2 + pixi-live2d-display 0.4.0.
  - Loaded as `<script>` tags in `index.html` from the bundled files in `live-2d/libs/`: `live2d.min.js` (Cubism 2), `live2dcubismcore.min.js` (Cubism 4 core), `pixi.min.js`, `pixi-live2d-display.min.js`, `pixi-live2d-display-extra.min.js`.
  - `package.json` also lists `pixi.js ^6.5.2` and `pixi-live2d-display ^0.3.1`, but nothing requires those npm packages.
  - The WebUI's Live2D preview loads its own copies from `live-2d/libs/v2/` (PixiJS 7.4.3 + pixi-live2d-display 0.5.0-ls-6).
  - The model registry only lists Cubism 3+ models (`.model3.json`).
- **VRM:** three.js `^0.183` + `@pixiv/three-vrm ^3.5`.
- **Local HTTP servers in the pet** (`js/services/http-server.js`):
  - music control on 3001,
  - emotion/avatar control on 3002. The control panel calls `/set-avatar-model` and `/switch-avatar-type` there (`postDesktop()` in `control-main.js`).
- **Python services:**
  - In `full-hub/`: ASR (`asr_api.py`, FastAPI, SenseVoice by default), TTS (GPT-SoVITS, run from `full-hub/tts-hub/GPT-SoVITS-Bundle` on port 5000), BERT (`omni_bert_api.py`), RAG (`run_rag.py`).
  - MemOS is separate, in `plugins-dlc/memos/`. `4.MEMOS-API.bat` starts it (API on port 8003).
- **WebUI:** Flask (`live-2d/webui/`), page `webui/templates/index_new.html`, JS `webui/static/new/js/app.js`.
- **LLM:** any OpenAI-compatible API. The user uses DeepSeek `deepseek-flash`, which has image input since Sept 2026 per search results; not tested by the user yet.
  - Tools come from plugins (`live-2d/plugins/`) and MCP servers (`live-2d/mcp/mcp_config.json`, Windows-MCP).
  - An approval gate asks before risky tools (`js/ai/tool-approval.js`, `tool_safety.json`).

## 5. Avatar architecture: where a new avatar type plugs in

- **`js/avatar/avatar-facade.js`:**
  - `AVATAR_TYPES = ['live2d', 'vrm', 'mmd', 'pngtuber']`, each with a DOM container. MMD and PNGTuber are slots without a driver ("not ported yet").
  - `register(type, driver)` adds a driver.
  - Engines named `pixi`, `three`, `three-mmd` get WebGL context handling.
  - It also handles switching between types (see `avatar-switch-transaction.js`, `transition-overlay.js`).
- **`js/avatar/drivers.js`:**
  - `registerBuiltinDrivers()` registers `live2d` and `vrm`.
  - A driver is an object like this:
    ```js
    {
      engine: 'pixi',            // or 'three'
      async init(context) {},    // context: modelController, config, ttsEnabled, asrEnabled, ttsProcessor, voiceChat
      async dispose() {},
      getModel() {},             // the model object other UI code reads (see below)
      getController() {},
      setEmotion(emotion) {},    // Live2D: emotionMapper.playConfiguredEmotion + expressionMapper.triggerExpressionByEmotion
      setMouth(value) {},        // Live2D: controller.setMouthOpenY(value)
      playMotion(indexOrGroup, index) {}
    }
    ```
  - The Live2D path sets globals other code still uses:
    - The driver's init sets `global.pixiApp`, `global.modelController`, `global.live2dStage` and `global.live2dLoader`.
    - `js/avatar/live2d/setup.js` (in `wireModel`) sets `global.currentModel`, `global.emotionEngine`, `global.emotionMapper`, `global.expressionMapper` and `global.currentCharacterName`. The driver's `setEmotion` and `playMotion` call those two mappers.
    - `js/app-initializer.js` sets `global.currentModel` again after startup.
    - The VRM driver sets `global.currentModel` in its own init, so a new driver should do the same.
- **`js/avatar/model-registry.js`:**
  - `scanLive2DModels()` scans `live-2d/2D/<name>/**/*.model3.json`. The user has `2D/肥牛` (the default, "Feiniu") and `2D/老肥牛` (Hiyori).
  - `scanVRMModels()` scans `3D/**/*.vrm`. There are also MMD and PNGTuber scanners.
  - An `emote` scanner would go here.
- **Config (`live-2d/config.json`, `ui` section):** `model_type` (`live2d` | `vrm`), `live2d_model` (folder name), `vrm_model`, `vrm_model_path`, `model_scale`, `model_position` (`x`, `y`, and `x_dual` / `y_dual` for multi-monitor), `show_model`, `avatar_motion_mode` (`blend`), `expression_engine` (`au`).
- **Model pickers:**
  - **Electron control panel:** `control-main.js` handlers `control:list-live2d-models`, `control:current-live2d-model` and `control:select-live2d-model`. VRM entries show as `[VRM] name`. Selecting writes `config.json` and calls the pet's `/set-avatar-model`.
  - **WebUI:** the model picker is `webui/avatar_manager.py`.
    - It serves `/api/avatar/models/<type>` and `/api/avatar/model/save`, which calls the pet's `/set-avatar-model`.
    - It sets `AVATAR_TYPES = ['live2d', 'vrm']`.
    - `webui/live2d_manager.py` holds the Live2D-only motions, expressions and idle settings, and parses `.model3.json` files.
  - **Expressions and motions tab (control panel):** it is Live2D-specific. It reads the model3.json expressions and motions and writes the emotion bindings.

### What the rest of the UI expects from `getModel()`

These UI features work for any avatar only if the model object provides these. Coordinates are **CSS px of the pet window**.

- **Bounds:** `getScreenHitBox()` or `getBounds()` (or `viewRect`), returning `{x, y, width, height}` or `{left, top, right, bottom}`.
  - `js/ui/ui-controller.js` `_getModelScreenBounds()` uses them.
  - They drive the tool-call bubbles and the new text box placement (`_startChatBoxFollow` / `updateChatBoxPosition`, math in `js/ui/chat-box-placement.js`).
- **Hit test:**
  - The right-click quick menu (`pointHitsModel` in `setupQuickPanel`) tries `controller.isPointOverModel(x, y)`, then `model.containsPoint({x, y})`, then the bounds box.
  - Mouse pass-through (`setupMouseIgnore`) tries `controller.isPointOverInteractive(x, y)`, then `model.containsPoint({x, y})`. It does nothing while `global.currentModel` is unset.
- **Anchor point:** `toGlobal({x: 0, y: 0})`. Used by `_getModelScreenPosition()` for the speech and lyrics bubbles.

The live VRM adapter (`js/avatar/vrm/model-adapter.js`, created in `js/avatar/vrm/manager.js`) implements `getScreenHitBox`, `isPointOverModel`, `containsPoint`, `viewRect` and `toGlobal`. Its controller (`js/avatar/vrm/interaction.js`) implements `isPointOverInteractive`. Together they are a good template for a non-Pixi driver. (`js/model/vrm-model-adapter.js` is an old copy that is not loaded.)

## 6. Where the Live2D model is loaded and rendered

- **Entry:** `drivers.js` `createLive2DDriver().init()` calls `Live2DSetup.initialize(...)` in `js/avatar/live2d/setup.js`.
- **The v2 Live2D stack in `js/avatar/live2d/`:**

  | File | Lines | Role |
  | --- | --- | --- |
  | `core.js` | 189 | The Pixi stage |
  | `model-loader.js` | 156 | Loads and positions the model |
  | `runtime.js` | 457 | Mouth, blink, breathing and gaze hooks |
  | `interaction.js` | 578 | Drag, hit area, click-through, dragging the text box |
  | `emotion-engine.js` | 811 | Emotion config, expressions and motions |
  | `param-director.js` | 948 | Drives the model parameters |
  | `facs-mapper.js` | 326 | Maps facial action units to parameters |
  | `face-micro-motion.js` | 243 | Small face movements |
  | `idle-action-scheduler.js` | 283 | Idle actions |
  | `vad-state.js` | 264 | Emotion state as valence/arousal/dominance (VAD) vectors, not voice activity |
  | `motion-style-presets.js` | | |
  | `duration-utils.js` | | |
  | `emotion-archetypes.js` | | |
  | `expression/` | | `au-driver.js`, `expression-solver.js`, `expression-units.js`, `semantic-actions.js` |

  Most roles are from the file names and the log lines. The internals were not read, apart from the corrections the fact-check made.
- **Old code, not loaded:** `js/model/` holds the pre-v2 code (`model-interaction.js`, `model-setup.js`, `model-path-updater.js`, `vrm-model-*.js`).
  - The running app does not load any of it. `app.js`, `js/avatar/drivers.js` and the setups use `js/avatar/live2d/*` and `js/avatar/vrm/*`.
  - **Do not edit or copy from `js/model/`.**
- **The user's startup log:**
  ```
  [Live2DStage] Ready: 4694x1095 CSS px, resolution=2, maxFPS=60
  [Live2DSetup] Found 2 models, using: 肥牛 (2D/肥牛/feiniu.model3.json)
  [Live2DLoader] transform: stage=4694x1095, rel=(0.825, 0.380), legacyScale=0.3468, appliedScale=0.1734, dual=true
  [ParamDirector] On, parameters=77, choreographable=22
  [Live2DRuntime] Installed: mouth=ParamMouthOpenY/PARAM_MOUTH_OPEN_Y/ParamMouthOpen, procedural blink=off (SDK native or no parameter), fallback breathing=off (SDK native), gaze follow=on (strength 0.3)
  [EmotionEngine] Character "肥牛" config loaded (legacy): 13 motion files / 13 expression files
  [AuDriver] No AU config for this model, using the built-in defaults: ...\2D\肥牛\expression_profile.json
  [AvatarFacade] Avatar type active: live2d
  ```

## 7. How the app drives the avatar

- **Lip sync:**
  - The driver's `setMouth(value)` calls `controller.setMouthOpenY(value)`.
  - `runtime.js` picks the mouth parameter (`ParamMouthOpenY` / `PARAM_MOUTH_OPEN_Y` / `ParamMouthOpen`). `emotion-engine.js` has a `LIPSYNC_PARAMS` list.
  - **Research this:** where the TTS audio level is turned into the mouth value, and what calls `setMouth`. Start with `js/avatar/avatar-voice-chat-binding.js` and the TTS processor in `js/voice/`.
- **Eye and mouse tracking:**
  - "gaze follow" is part of `runtime.js` (strength 0.3 in the log).
  - Pointer handling (drag, hit test, click-through) is in `interaction.js`.
  - `ui-controller.js` `setupMouseIgnore()` toggles pass-through over the model and UI.
  - **Research this:** how the gaze target is computed, given that the window spans several monitors.
- **Idle motion:**
  - Blink and breathing come from the Cubism SDK when the model has them ("SDK native" in the log).
  - `face-micro-motion.js` adds small face movements (in `blend` and `director` modes).
  - `idle-action-scheduler.js` adds discrete idle actions such as nods and head tilts, but only when `ui.avatar_motion_mode` is `director`. With the user's `blend` it does not run.
  - Both are driven from `param-director.js`.
  - `js/avatar/motion-mode.js` handles `avatar_motion_mode`.
  - **Research this:** the details.
- **Emotions (from the LLM):**
  - The persona prompt (`config.json` `llm.system_prompt`, English) tells her to write six Chinese tags: `<开心>` happy, `<生气>` angry, `<难过>` sad, `<惊讶>` surprised, `<害羞>` shy, `<俏皮>` playful. The app reads these exact Chinese strings, so keep them as they are.
  - Tags are stripped from subtitles (`showSubtitle` in `ui-controller.js`).
  - Emotion → expression/motion bindings are per model, keyed by model folder name:
    - `live-2d/emotion_expressions.json` and `live-2d/emotion_actions.json`,
    - a per-model file `2D/<name>/emotion_mapping.json` (`sidecarPath` in `control-main.js`).
  - New models get defaults from `js/avatar/model-defaults.js`.
  - The mappers are the EmotionEngine in `js/avatar/live2d/emotion-engine.js`: its `motionFacade` and `expressionFacade`, exposed as `global.emotionMapper` and `global.expressionMapper` by `setup.js`.
  - `js/ui/emotion-expression-mapper.js` and `js/ui/emotion-motion-mapper.js` are legacy and only used by the unused `js/model/model-setup.js`.
  - On top of that, a facial action unit (AU) pipeline builds expressions from parameters. It lives in `expression/au-driver.js` and `expression-solver.js`, and reads `2D/<name>/expression_profile.json` (via `loadExpressionProfile` in `expression/expression-units.js`, with built-in defaults if the file is missing). It is active when all three hold, as they do in the user's config:
    - `ui.expression_engine` is `"au"` (the default),
    - `expression_solver.enabled` is not false,
    - `ui.avatar_motion_mode` is not `director`.
  - `js/ai/motion-director.js` optionally asks an LLM for body and face keyframes (NDJSON, English prompts) while she speaks. It works through `param-director.js`.
  - `js/ai/motion-directives.js` spots motion commands she writes in brackets, like `（挥手）` (Chinese keywords plus "wink").
  - **Research this:** where the tags are parsed out of the streamed reply, and the order: tag → `avatarFacade` → driver `setEmotion`.
  - For E-mote, `setEmotion` would map the six emotions to the model's own timelines or variables. The AU and choreography layers are Live2D/Pixi-specific and would not apply.

## 8. User context

- Windows, **several monitors** (the pet window spans them). Time zone Europe/Oslo. English speaker.
- Chat model: DeepSeek `deepseek-flash`. Local TTS (GPT-SoVITS, Neuro voice) and ASR (SenseVoice) are running.
- Enabled plugins: `built-in/web-search`, `community/dawn-dusk-line` (time awareness, now uses the computer's time zone).
- The user's log shows `MCP status: 2 servers, 1 tools`. The one tool is the built-in `mcp/tools/random-acg-pic.js`. Windows-MCP probably wasn't ready yet when counted after 68 ms, or it failed. **Not verified.** Ask the user to test PC control.
- The user talks to her by typing too. The text box now appears next to her (commit `0babe15`); the user has not confirmed it on their PC yet.

## 9. E-mote research already done

Web research only. No E-mote file or engine was run.

- **E-mote** is M2's closed-source engine. Model files are PSB (`.psb`, also `.emtbytes`, `.pimg`, `.mtn` ...). Models inside commercial games are **encrypted**.
- **[FreeMote](https://github.com/UlyssesWu/FreeMote)** (UlyssesWu, CC BY-NC-SA 4.0):
  - PSB tools: `PsbDecompile`, `PsBuild`, `EmtConvert` (converts between EMT PSB formats, also encrypted ↔ pure), and `EmtMake` (to MMO projects).
  - `FreeMote Viewer` renders **statically** only.
  - It does **not** convert to Live2D, Spine or other formats.
- **[FreeMote SDK](https://github.com/Project-AZUSA/FreeMote-SDK)** (Project-AZUSA):
  - Special E-mote engine builds that take **pure (unencrypted) PSB**: Windows DX9 and DX11, **WebGL v3.9 (JS/WASM)**, Unity (incl. WebGL), Kirikiri, and .NET ([FreeMote.NET](https://github.com/Project-AZUSA/FreeMote.NET)).
  - License: binaries CC BY-NC-SA 4.0, source LGPLv3. That means **non-commercial use only**, so no monetized streams.
- **[amadeus-emote-loader](https://github.com/Mieluoxxx/amadeus-emote-loader)** (Rust, Apache-2.0, native + wasm):
  - It parses and "bakes" PSB models so the older runtime (the FreeMote SDK WebGL build) can load them.
  - It handles expressions (selector tracks), transforms, eye control and part visibility.
  - It renders nothing itself. Its README says rendering needs M2's runtime, supplied separately.
  - A similar project, apparently for an AI-companion-like app. Read its README for how it drives the runtime.
- **[FreeMote-ViewerEx](https://github.com/O2C14/FreeMote-ViewerEx)** (C#, .NET 4.8): a static viewer.
- **Why it fits this app:**
  - The pet window is Chromium (Electron 28), so the **WebGL engine build** can run in the renderer.
  - It would draw into its own canvas or container under a new avatar type, for example `emote` with its own `engine` name.
- **Unknown, research this:**
  - the WebGL engine's JS API (load a PSB, play timelines, set variables like mouth, eyes and head angle, blend, transparency),
  - whether it runs in Electron 28 with Node integration on,
  - performance on a 4694 px wide transparent canvas,
  - which E-mote version the user's model is and whether it needs amadeus-emote-loader's conversion.
- **Legal line held with the user:**
  - Models from commercial visual novels are encrypted and belong to the studios. Getting them out breaks most games' terms.
  - The cloud session **declined to help decrypt game files.** Only use models the user made or has permission to use.
  - Don't commit model files or FreeMote binaries to the repo. The repo may be public, and the licenses are non-commercial.

## 10. Already done: do not redo

- **The English UI** (WebUI, pet window, Electron control panel, installer, logs, plugin names) and **English LLM-facing text** (core prompts, all plugins). Chinese that stays on purpose:
  - emotion tags,
  - `AI记录室` file names,
  - the `记忆库.txt` log format,
  - model folder names `肥牛` / `老肥牛`,
  - old markers kept for compatibility.
- **The text box follows the model** (commit `0babe15`): `js/ui/chat-box-placement.js`, `ui-controller.js`. The E-mote driver only needs to provide model bounds (section 5).
- **Model switching, voice cloning and TTS start scripts** were looked at:
  - The TTS **Start** button always runs `2.TTS.bat`.
  - The voice clone tool writes a separate .bat in `live-2d/Voice_Model_Factory/`: `<role_name>.bat` from the WebUI (`webui/log_monitor.py` `generate_tts_bat`), `<name>_TTS.bat` from the Electron control panel (`control:generate-voice-bat`). Neither changes what the Start button runs.
- **DeepSeek vision** was researched (the answer is "probably yes" with `deepseek-flash`). The separate vision model in `js/ai/llm-handler.js` answers the whole turn itself, not just a description.
- **The installer** was reviewed: it downloads from ModelScope; resume is missing; it downloads unused models (paraformer-zh, punctuation, BERT).

## 11. Known open items (not E-mote)

- **Subtitles** still default to the bottom-right of the Windows main display (`ui-controller.js`, the positioning block in `setupChatBoxEvents` and `applySubtitlePosition()`). On multiple monitors they are probably out of view too. The user was offered "make them follow her too".
- **Installer improvements** were offered, not done: resume downloads, reuse a pre-downloaded file, skip unneeded models, BERT off by default.
- **Upstream API keys** in the repo (section 2).
