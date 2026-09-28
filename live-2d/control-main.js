const { app, BrowserWindow, ipcMain, shell, net, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const http = require('http');
const nodeNet = require('node:net');
const { scanLive2DModels, resolveLive2DModel, scanVRMModels } = require('./js/avatar/model-registry');
const { EMOTIONS: motionEmotions, mergeExpressionConfig, mergeActionConfig, isLive2DModelDir } = require('./js/avatar/model-defaults');
const { loadProvidersFromStore, saveProviders } = require('./js/core/llm-provider-store');

const configPath = path.join(__dirname, 'config.json');
const pluginsPath = path.join(__dirname, 'plugins');
let live2dProcess = null;
const runtimeLogPath = path.join(__dirname, 'runtime.log');
let runtimeLogSender = null;
let runtimeLogLength = 0;
let runtimeLogRemainder = '';
let controlWindow = null;

// 🔥 单实例锁：反复双击 肥牛.exe 之前会一直开新窗口/新进程，
// 拿不到锁就直接退出，并把已有窗口拉到前台。
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}
app.on('second-instance', () => {
  if (!controlWindow || controlWindow.isDestroyed()) return;
  if (controlWindow.isMinimized()) controlWindow.restore();
  controlWindow.show();
  controlWindow.focus();
});
let selectedVoiceModelPath = '';
let selectedVoiceAudioPath = '';
let avatarLoadingWindow = null;
let avatarLoadingTimer = null;

function closeAvatarLoadingWindow() {
  clearTimeout(avatarLoadingTimer);
  avatarLoadingTimer = null;
  if (avatarLoadingWindow && !avatarLoadingWindow.isDestroyed()) avatarLoadingWindow.destroy();
  avatarLoadingWindow = null;
}

function showAvatarLoadingWindow() {
  closeAvatarLoadingWindow();
  const displays = require('electron').screen.getAllDisplays();
  const minX = Math.min(...displays.map(display => display.bounds.x));
  const minY = Math.min(...displays.map(display => display.bounds.y));
  const maxX = Math.max(...displays.map(display => display.bounds.x + display.bounds.width));
  const maxY = Math.max(...displays.map(display => display.bounds.y + display.bounds.height));
  const cached = readJson(path.join(__dirname, 'avatar-loading-position.json'), null);
  const config = readJson(configPath, {});
  const pos = config.ui?.model_position || {};
  const relX = Number.isFinite(cached?.x) ? cached.x : Math.max(0, Math.min(1, Number(pos.x) || 0.65));
  const relY = Number.isFinite(cached?.y) ? cached.y : Math.max(0, Math.min(1, Number(pos.y) || 0.38));
  const size = 72;
  avatarLoadingWindow = new BrowserWindow({
    x: Math.round(minX + (maxX - minX) * relX - size / 2),
    y: Math.round(minY + (maxY - minY) * relY - size / 2),
    width: size,
    height: size,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    focusable: false,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  });
  avatarLoadingWindow.setIgnoreMouseEvents(true);
  avatarLoadingWindow.setAlwaysOnTop(true, 'screen-saver');
  avatarLoadingWindow.loadFile('avatar-loading.html');
  avatarLoadingWindow.once('ready-to-show', () => avatarLoadingWindow?.showInactive());
  avatarLoadingTimer = setTimeout(closeAvatarLoadingWindow, 30000);
}

function cleanToolLog(line) {
  return line
    .replace(/^(?:\[[^\]\r\n]+\]\s*)+/, '')
    .replace(/(?:插件已加载|Plugin loaded)[：:]\s*/u, '')
    .trim();
}

function cleanPetLog(line) {
  if (/\[Live2DStage\]\s*初始化完成|\[Live2DSetup\]\s*共发现|\[Live2DLoader\]\s*(?:开始加载模型|transform:|模型加载完成)|\[ParamDirector\]\s*已启用|\[Live2DRuntime\]\s*已安装|\[EmotionEngine\].*配置加载完成|\[AuDriver\]\s*(?:未找到模型 AU 配置|跳过不可映射 AU|已就绪|解算)|\[AvatarFacade\]\s*形态已激活/.test(line)) return null;
  // the same lines as the English pet logs them
  if (/\[Live2DStage\]\s*Ready:|\[Live2DSetup\]\s*Found|\[Live2DLoader\]\s*(?:Loading model|Model loaded)|\[ParamDirector\]\s*On,|\[Live2DRuntime\]\s*Installed:|\[EmotionEngine\].*config loaded|\[AuDriver\]\s*(?:No AU config for this model|Skipping unmappable AU|Ready:|Solved)|\[AvatarFacade\]\s*Avatar type active/.test(line)) return null;
  if (/插件热加载监听已启动|\[Plugin:core_memory_injector\].*(?:不存在，跳过加载|插件已启动)|\[Plugin:dawn_dusk_line\].*已启动|\[Plugin:user_profile\].*(?:插件已启动|MemOS 不可用)|\[MotionDirector\]\s*(?:body|face)\s*失败，保留本地编舞|对话模型[：:].*提供商|配置文件加载成功|AI回复中/.test(line)) return null;
  if (/Plugin hot-reload watcher started|\[MotionDirector\]\s*(?:body|face)\s*failed, keeping local choreography|Chat model:.*\(provider|Config file loaded|AI is replying/.test(line)) return null;
  if (/已将内容发送给AI/.test(line)) return null;
  const modelMatch = line.match(/已加载\s*\d+\s*个\s*LLM\s*提供商[^\n]*?当前模型[：:]\s*([^）)\s]+)/i)
    || line.match(/Loaded\s*\d+\s*LLM\s*providers[^\n]*?current model:\s*([^)\s]+)/i);
  return modelMatch ? `Current model: ${modelMatch[1]}` : line.replace(/\[Plugin:[^\]\r\n]+\][ \t]*/g, '');
}

function pumpRuntimeLog(flush = false) {
  if (!runtimeLogSender || runtimeLogSender.isDestroyed() || !fs.existsSync(runtimeLogPath)) return;
  try {
    const content = fs.readFileSync(runtimeLogPath, 'utf8');
    if (content.length < runtimeLogLength) runtimeLogLength = 0;
    runtimeLogRemainder += content.slice(runtimeLogLength);
    runtimeLogLength = content.length;
    const lines = runtimeLogRemainder.split(/\r?\n/);
    runtimeLogRemainder = flush ? '' : lines.pop();
    if (flush && lines.length && !lines[lines.length - 1]) lines.pop();
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      if (/\[AvatarFacade\]\s*(?:形态已激活|Avatar type active)|\[Live2DLoader\]\s*(?:模型加载完成|Model loaded)/.test(line)) closeAvatarLoadingWindow();
      const channel = line.includes('[TOOL]') ? 'control:tool-log' : 'control:live2d-log';
      const cleaned = channel === 'control:tool-log' ? cleanToolLog(line) : cleanPetLog(line);
      if (cleaned) runtimeLogSender.send(channel, `${cleaned}\n`);
    }
  } catch (error) {
    if (!runtimeLogSender.isDestroyed()) runtimeLogSender.send('control:live2d-log', `Error reading the log file: ${error.message}\n`);
  }
}

function startRuntimeLog(sender) {
  fs.unwatchFile(runtimeLogPath);
  fs.writeFileSync(runtimeLogPath, '', 'utf8');
  runtimeLogSender = sender;
  runtimeLogLength = 0;
  runtimeLogRemainder = '';
  fs.watchFile(runtimeLogPath, { interval: 100 }, () => pumpRuntimeLog());
}

function stopRuntimeLog() {
  pumpRuntimeLog(true);
  fs.unwatchFile(runtimeLogPath);
  runtimeLogSender = null;
  runtimeLogLength = 0;
  runtimeLogRemainder = '';
}
const serviceProcesses = { tts: null, asr: null, bert: null };
const serviceDownloads = { tts: null, asr: null, bert: null };
const serviceDefinitions = {
  tts: { name: 'TTS (voice)', port: 5000, bat: '2.TTS.bat', flag: '--tts', checks: [
    'tts-hub/GPT-SoVITS-Bundle/runtime', 'tts-hub/GPT-SoVITS-Bundle/GPT_SoVITS'
  ] },
  asr: { name: 'ASR (speech recognition)', port: 1000, bat: '1.ASR.bat', flag: '--asr', checks: [
    'asr-hub/model/torch_hub/snakers4_silero-vad_master',
    'asr-hub/model/asr/models/iic/speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch/config.yaml',
    'asr-hub/model/asr/models/iic/punc_ct-transformer_cn-en-common-vocab471067-large/config.yaml',
    'asr-hub/model/asr/models/iic/punc_ct-transformer_cn-en-common-vocab471067-large/model.pt'
  ] },
  bert: { name: 'BERT (model service)', port: 6007, bat: '3.bert.bat', flag: '--bert', checks: [
    'bert-hub/config.json', 'bert-hub/model.safetensors', 'bert-hub/vocab.txt'
  ] }
};
const projectRoot = path.resolve(__dirname, '..');
const hubRoot = path.join(projectRoot, 'full-hub');
const projectEnvPython = path.join(projectRoot, 'env', 'python.exe');
const projectEnvUrl = 'https://modelscope.cn/models/morelle/my-neuro-env/resolve/master/my-neuro-env.tar.gz';

async function ensureProjectPython(sender, service) {
  if (fs.existsSync(projectEnvPython)) return projectEnvPython;
  const tempDir = fs.mkdtempSync(path.join(app.getPath('temp'), 'my-neuro-env-'));
  const archive = path.join(tempDir, 'my-neuro-env.tar.gz');
  const envDir = path.join(projectRoot, 'env');
  sendServiceLog(sender, service, '@@ENV_START\n');
  sendServiceLog(sender, service, 'The project Python environment was not found. Downloading morelle/my-neuro-env...\n');
  try {
    const response = await net.fetch(projectEnvUrl, { redirect: 'follow' });
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
    const total = Number(response.headers.get('content-length')) || 0;
    let received = 0;
    let lastPercent = -1;
    const progressStream = new (require('node:stream').Transform)({
      transform(chunk, _encoding, callback) {
        received += chunk.length;
        const percent = total ? Math.min(100, Math.floor(received / total * 100)) : 0;
        if (percent !== lastPercent) {
          lastPercent = percent;
          sendServiceLog(sender, service, `@@ENV_PROGRESS:${percent}:${received}:${total}\n`);
        }
        callback(null, chunk);
      }
    });
    await pipeline(Readable.fromWeb(response.body), progressStream, fs.createWriteStream(archive));
    fs.mkdirSync(envDir, { recursive: true });
    sendServiceLog(sender, service, '@@ENV_EXTRACT\n');
    sendServiceLog(sender, service, 'Project Python environment downloaded, extracting...\n');
    await new Promise((resolve, reject) => {
      const child = spawn('tar.exe', ['-xzf', archive, '-C', envDir], { windowsHide: true });
      let errorText = '';
      child.stderr.on('data', chunk => { errorText += String(chunk); });
      child.once('error', reject);
      child.once('exit', code => code === 0 ? resolve() : reject(new Error(errorText.trim() || `tar.exe ${code}`)));
    });
    if (!fs.existsSync(projectEnvPython)) throw new Error('env\\python.exe was not found after extracting');
    sendServiceLog(sender, service, '@@ENV_DONE\n');
    sendServiceLog(sender, service, 'Project Python environment installed.\n');
    return projectEnvPython;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function serviceLaunchDefinition(id) {
  const definition = serviceDefinitions[id];
  if (id !== 'asr' || !definition) return definition;
  const current = readJson(configPath, {});
  if (current.cloud?.baidu_asr?.enabled === true) {
    return { ...definition, name: 'Baidu streaming ASR (VAD only)', bat: 'VAD.bat' };
  }
  if (current.cloud?.siliconflow_asr?.enabled === true) {
    return { ...definition, name: 'SiliconFlow ASR (local VAD)' };
  }
  return { ...definition, name: 'Local ASR' };
}

function serviceInstalled(definition) {
  return definition.checks.every(item => fs.existsSync(path.join(hubRoot, item)));
}

function portListening(port) {
  return new Promise(resolve => {
    const socket = nodeNet.createConnection({ host: '127.0.0.1', port });
    const finish = value => { socket.removeAllListeners(); socket.destroy(); resolve(value); };
    socket.setTimeout(450);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

function sendServiceLog(sender, service, text) {
  if (!sender.isDestroyed()) sender.send('control:service-log', { service, text: String(text) });
}

async function serviceStatus() {
  return Promise.all(Object.entries(serviceDefinitions).map(async ([id, definition]) => {
    const listening = await portListening(definition.port);
    const processActive = Boolean(serviceProcesses[id] && serviceProcesses[id].exitCode === null);
    return {
      id, name: definition.name, port: definition.port,
      installed: serviceInstalled(definition),
      downloading: Boolean(serviceDownloads[id]),
      running: listening || processActive,
      starting: processActive && !listening
    };
  }));
}

async function stopConfiguredServices() {
  for (const [id, definition] of Object.entries(serviceDefinitions)) {
    const pids = await listeningPids(definition.port);
    if (serviceProcesses[id]?.pid) pids.push(String(serviceProcesses[id].pid));
    for (const pid of new Set(pids)) {
      await runProcess('taskkill.exe', ['/pid', pid, '/t', '/f']).catch(() => {});
    }
    serviceProcesses[id] = null;
    if (serviceDownloads[id]?.pid) {
      await runProcess('taskkill.exe', ['/pid', String(serviceDownloads[id].pid), '/t', '/f']).catch(() => {});
      serviceDownloads[id] = null;
    }
  }
}

function listeningPids(port) {
  return new Promise(resolve => {
    const child = spawn('netstat.exe', ['-ano', '-p', 'tcp'], { windowsHide: true });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk.toString(); });
    child.on('error', () => resolve([]));
    child.on('exit', () => {
      const pids = new Set();
      for (const line of output.split(/\r?\n/)) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 5 && parts[1]?.endsWith(`:${port}`) && parts[3] === 'LISTENING') pids.add(parts[4]);
      }
      resolve([...pids]);
    });
  });
}

function readJson(filePath, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return fallback; }
}

function loadControlConfig() {
  const config = readJson(configPath, {});
  config.tts ||= {};
  config.asr ||= {};
  config.tts.enabled = true;
  config.asr.enabled = true;
  config.llm ||= {};
  const providers = loadProvidersFromStore(__dirname).providers;
  const provider = providers.find(item => item.id === config.llm.provider_id)
    || providers.find(item => item.enabled !== false)
    || providers[0];
  // An explicitly saved empty model is intentional; only legacy configs need a default.
  const hasModelSelection = Object.prototype.hasOwnProperty.call(config.llm, 'model_id');
  const model = hasModelSelection
    ? provider?.models?.find(item => item.model_id === config.llm.model_id)
    : provider?.models?.find(item => item.enabled !== false) || provider?.models?.[0];
  if (hasModelSelection) config.llm.model = config.llm.model_id || '';
  if (provider) {
    config.llm.provider_id = provider.id;
    config.llm.api_key = provider.api_key || '';
    config.llm.api_url = provider.api_url || '';
  }
  if (model) {
    config.llm.model_id = model.model_id;
    config.llm.model = model.model_id;
    if (model.temperature !== undefined) config.llm.temperature = model.temperature;
    if (model.temperature_enabled !== undefined) config.llm.temperature_enabled = model.temperature_enabled;
  }
  config.vision ||= {};
  config.vision.vision_model ||= {};
  const visionProvider = providers.find(item => item.id === config.vision.provider_id);
  const hasVisionModelSelection = Object.prototype.hasOwnProperty.call(config.vision, 'model_id');
  const visionModel = hasVisionModelSelection
    ? visionProvider?.models?.find(item => item.model_id === config.vision.model_id)
    : visionProvider?.models?.find(item => item.enabled !== false) || visionProvider?.models?.[0];
  if (hasVisionModelSelection) config.vision.vision_model.model = config.vision.model_id || '';
  if (visionProvider) {
    config.vision.vision_model.api_key = visionProvider.api_key || '';
    config.vision.vision_model.api_url = visionProvider.api_url || '';
  }
  if (visionModel) config.vision.vision_model.model = visionModel.model_id;
  return config;
}

function saveControlConfig(config) {
  config.llm ||= {};
  const providers = loadProvidersFromStore(__dirname).providers;
  let provider = providers.find(item => item.id === config.llm.provider_id)
    || providers.find(item => item.enabled !== false)
    || providers[0];
  if (!provider) {
    provider = { id: 'main', name: 'Main model', api_key: '', api_url: '', enabled: true, models: [] };
    providers.push(provider);
  }
  provider.api_key = String(config.llm.api_key || '');
  provider.api_url = String(config.llm.api_url || '');
  provider.enabled = true;
  provider.models ||= [];
  const modelId = String(Object.prototype.hasOwnProperty.call(config.llm, 'model') ? config.llm.model : (config.llm.model_id || '')).trim();
  let model = provider.models.find(item => item.model_id === modelId);
  if (modelId && !model) {
    model = { model_id: modelId, name: modelId, enabled: true };
    provider.models.push(model);
  }
  if (model) {
    model.enabled = true;
    model.temperature = Number(config.llm.temperature ?? model.temperature ?? 1);
    model.temperature_enabled = Boolean(config.llm.temperature_enabled);
  }
  config.llm.provider_id = provider.id;
  config.llm.model_id = modelId;
  config.vision ||= {};
  const visionView = config.vision.vision_model || {};
  const visionModelId = String(Object.prototype.hasOwnProperty.call(visionView, 'model') ? visionView.model : (config.vision.model_id || '')).trim();
  const hasVisionConfig = Boolean(String(visionView.api_key || '').trim() || String(visionView.api_url || '').trim() || visionModelId);
  if (hasVisionConfig) {
    let visionProvider = providers.find(item => item.id === config.vision.provider_id);
    if (!visionProvider) {
      visionProvider = providers.find(item => item.api_key === String(visionView.api_key || '') && item.api_url === String(visionView.api_url || ''));
    }
    if (!visionProvider) {
      let id = 'vision';
      let suffix = 2;
      while (providers.some(item => item.id === id)) id = `vision-${suffix++}`;
      visionProvider = { id, name: 'Vision model', api_key: '', api_url: '', enabled: true, models: [] };
      providers.push(visionProvider);
    }
    visionProvider.api_key = String(visionView.api_key || '');
    visionProvider.api_url = String(visionView.api_url || '');
    visionProvider.enabled = true;
    visionProvider.models ||= [];
    if (visionModelId && !visionProvider.models.some(item => item.model_id === visionModelId)) {
      visionProvider.models.push({ model_id: visionModelId, name: visionModelId, enabled: true });
    }
    config.vision.provider_id = visionProvider.id;
    config.vision.model_id = visionModelId;
  } else {
    config.vision.provider_id = '';
    config.vision.model_id = '';
  }
  config.vision.vision_model = {};
  delete config.llm.api_key;
  delete config.llm.api_url;
  delete config.llm.model;
  delete config.llm.temperature;
  delete config.llm.temperature_enabled;
  saveProviders(__dirname, providers);
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

function listPlugins() {
  const enabled = new Set(readJson(path.join(pluginsPath, 'enabled_plugins.json'), { plugins: [] }).plugins || []);
  const result = { builtIn: [], community: [], market: [] };
  for (const [type, key] of [['built-in', 'builtIn'], ['community', 'community']]) {
    const base = path.join(pluginsPath, type);
    if (!fs.existsSync(base)) continue;
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(base, entry.name);
      const metaPath = path.join(dir, 'metadata.json');
      if (!fs.existsSync(metaPath)) continue;
      const meta = readJson(metaPath, {});
      const configFile = path.join(dir, 'plugin_config.json');
      result[key].push({ type, name: entry.name, relPath: `${type}/${entry.name}`,
        displayName: meta.displayName || meta.name || entry.name, description: meta.description || '',
        author: meta.author || '', version: meta.version || '', enabled: enabled.has(`${type}/${entry.name}`),
        hasConfig: fs.existsSync(configFile), config: readJson(configFile, {}),
        hasReadme: fs.existsSync(path.join(dir, 'README.md')), bat: meta.bat || '', downloadDlc: meta.download_dlc || '',
        dlcInstalled: !meta.download_dlc || fs.existsSync(path.join(__dirname, 'plugins-dlc', entry.name)) });
    }
    result[key].sort((a, b) => a.displayName.localeCompare(b.displayName, 'zh-CN'));
  }
  const market = readJson(path.join(pluginsPath, 'plugin-house', 'plugin_hub.json'), {});
  const marketDisplayNames = {
    'time-awareness': 'Time Awareness',
    'my-neuro-plugin-hitokoto': 'Daily Quote',
    'my-neuro-plugin-memos': 'MemOS Long-Term Memory',
    'loki-shadow': 'Shadow of Loki',
    'myneuro-plugin-skills': 'Skill Manager',
    'core-memory-injector': 'Core Memory Injector',
    'astrbook-forum': 'AstrBook Forum',
    'world-eye': 'Eye of the World',
    'ai-log': 'AI Journal',
    'dawn-dusk-line': 'Dawn and Dusk',
    'mood-chat': 'Mood Chat',
    'thinking-bubble': 'Thinking Bubble',
    'rebirth-feiniu-music': 'NetEase Cloud Music',
    'bilibili-tools': 'Bilibili Tools',
    'multi-search': 'Multi-Engine Search',
    'openrouter-image': 'OpenRouter Image Generation',
    'windows-app-launcher': 'Windows App Launcher',
    'mcp-filesystem': 'MCP File System',
    'remote-sync': 'Remote Sync',
    'exp3-model-processor': 'EXP3 Expression Organizer',
    'check-in': 'Check-In',
    'txt-writer': 'Text Writer',
    'minimax-music': 'MiniMax Music Generation',
    'feiniu-board-game': 'Feiniu Board Games',
    'kimi-search': 'Kimi Web Search',
    'agent-dream': 'Dream System',
    'qq-connect': 'QQ Connect',
    'timed-tasks': 'Scheduled Tasks',
    'screen-narrator': 'Screen Awareness'
  };
  result.market = Object.entries(market).map(([id, item]) => {
    const installedPlugin = result.community.find(plugin => plugin.name === id);
    return {
      id,
      ...item,
      display_name: installedPlugin?.displayName || marketDisplayNames[id] || item.display_name || id,
      installed: Boolean(installedPlugin)
    };
  });
  return result;
}

const pluginMarketUrl = 'https://raw.githubusercontent.com/morettt/my-neuro/main/live-2d/plugins/plugin-house/plugin_hub.json';

async function refreshPluginMarket() {
  const response = await net.fetch(pluginMarketUrl, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Failed to get the plugin list (HTTP ${response.status})`);
  const market = await response.json();
  if (!market || Array.isArray(market) || typeof market !== 'object') throw new Error('The plugin list has an invalid format');
  fs.writeFileSync(path.join(pluginsPath, 'plugin-house', 'plugin_hub.json'), `${JSON.stringify(market, null, 2)}\n`, 'utf8');
  return listPlugins();
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, ...options });
    let output = '';
    child.stdout?.on('data', chunk => { output += chunk.toString(); });
    child.stderr?.on('data', chunk => { output += chunk.toString(); });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve(output) : reject(new Error(output.trim() || `${command} exited with code ${code}`)));
  });
}

async function downloadFile(url, file) {
  const response = await net.fetch(url, { signal: AbortSignal.timeout(180000) });
  if (!response.ok) throw new Error(`Download failed (HTTP ${response.status})`);
  fs.writeFileSync(file, Buffer.from(await response.arrayBuffer()));
}

async function expandZip(zipFile, destination) {
  fs.mkdirSync(destination, { recursive: true });
  await runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '$ErrorActionPreference = "Stop"; [Console]::OutputEncoding = [Text.UTF8Encoding]::new(); Expand-Archive -LiteralPath $env:MY_NEURO_PLUGIN_ZIP -DestinationPath $env:MY_NEURO_PLUGIN_DESTINATION -Force'], {
    env: {
      ...process.env,
      MY_NEURO_PLUGIN_ZIP: zipFile,
      MY_NEURO_PLUGIN_DESTINATION: destination
    }
  });
}

async function installDependencies(pluginDir) {
  const messages = [];
  if (fs.existsSync(path.join(pluginDir, 'requirements.txt'))) {
    await runProcess('python.exe', ['-m', 'pip', 'install', '-r', path.join(pluginDir, 'requirements.txt')], { cwd: pluginDir });
    messages.push('Python dependencies installed');
  }
  return messages;
}

async function installPluginArchive(id, repo) {
  if (!/^[\w.-]+$/.test(id) || !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(?:\.git)?\/?$/i.test(repo)) throw new Error('Invalid plugin info');
  const target = path.join(pluginsPath, 'community', id);
  if (fs.existsSync(target)) throw new Error('The plugin is already installed');
  const match = repo.replace(/\.git\/?$/i, '').match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)$/i);
  const temp = fs.mkdtempSync(path.join(app.getPath('temp'), 'my-neuro-plugin-'));
  const zipFile = path.join(temp, 'plugin.zip');
  const extractDir = path.join(temp, 'extract');
  try {
    let lastError;
    for (const branch of ['main', 'master']) {
      try { await downloadFile(`https://github.com/${match[1]}/${match[2]}/archive/refs/heads/${branch}.zip`, zipFile); lastError = null; break; }
      catch (error) { lastError = error; }
    }
    if (lastError) throw lastError;
    await expandZip(zipFile, extractDir);
    const roots = fs.readdirSync(extractDir, { withFileTypes: true }).filter(entry => entry.isDirectory());
    if (roots.length !== 1) throw new Error('The plugin archive has an invalid layout');
    const source = path.join(extractDir, roots[0].name);
    if (!fs.existsSync(path.join(source, 'metadata.json'))) throw new Error('The repository root is missing metadata.json');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(source, target, { recursive: true });
    const dependencyMessages = await installDependencies(target);
    return { ok: true, message: ['Plugin installed', ...dependencyMessages].join(', ') };
  } catch (error) {
    if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
    throw error;
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function postDesktop(route, payload, timeout = 2500) {
  return new Promise(resolve => {
    const body = JSON.stringify(payload);
    const request = http.request({ hostname: '127.0.0.1', port: 3002, path: route, method: 'POST', timeout,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, response => {
      let text = '';
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => { try { resolve(JSON.parse(text)); } catch { resolve({ success: response.statusCode < 400, message: text }); } });
    });
    request.on('timeout', () => request.destroy(new Error('The pet did not respond in time')));
    request.on('error', error => resolve({ success: false, message: error.message }));
    request.end(body);
  });
}

const motionFile = kind => path.join(__dirname, kind === 'actions' ? 'emotion_actions.json' : 'emotion_expressions.json');
const motionRootKey = kind => kind === 'actions' ? 'emotion_actions' : 'emotion_expressions';
const mergeMotionConfig = (kind, character, existing) => (kind === 'actions' ? mergeActionConfig : mergeExpressionConfig)(character, existing);
// WebUI 保存过的模型会有 per-model sidecar（2D/<模型>/emotion_mapping.json），桌宠优先读它而不是中央配置；
// 面板必须同样以它为准读写，否则这里的改动桌宠看不到。
const sidecarPath = character => path.join(__dirname, '2D', character, 'emotion_mapping.json');
const sidecarKeys = kind => kind === 'actions' ? { list: 'motions', named: 'actions' } : { list: 'expressions', named: 'expressions_named' };

function readMotionConfig(character, kind) {
  const sidecar = readJson(sidecarPath(character), null);
  if (!sidecar || typeof sidecar !== 'object') return readJson(motionFile(kind), {})[character]?.[motionRootKey(kind)];
  const { list, named } = sidecarKeys(kind);
  const config = {};
  for (const [emotion, entry] of Object.entries(sidecar.emotions || {})) if (Array.isArray(entry?.[list])) config[emotion] = entry[list];
  for (const [name, files] of Object.entries(sidecar[named] || {})) if (Array.isArray(files)) config[name] = files;
  return config;
}

function writeMotionConfig(character, kind, values) {
  const file = motionFile(kind);
  const all = readJson(file, {});
  all[character] ||= {};
  all[character][motionRootKey(kind)] = values;
  fs.writeFileSync(file, `${JSON.stringify(all, null, 2)}\n`, 'utf8');
  const sidecar = readJson(sidecarPath(character), null);
  if (!sidecar || typeof sidecar !== 'object') return;
  const { list, named } = sidecarKeys(kind);
  sidecar.emotions ||= {};
  sidecar[named] = {};
  for (const [key, files] of Object.entries(values)) {
    if (motionEmotions.includes(key)) (sidecar.emotions[key] ||= {})[list] = files;
    else sidecar[named][key] = files;
  }
  fs.writeFileSync(sidecarPath(character), `${JSON.stringify(sidecar, null, 2)}\n`, 'utf8');
}

// 桌宠运行中时让它重读表情/动作配置；未运行则静默忽略（下次启动自然生效）
const notifyDesktopReload = () => postDesktop('/reload-config', {}, 3000);

// 面板展示的配置以模型目录为准：没有条目就按目录生成，有条目就补齐新增文件、剔除已删除的文件。
// 这样用户直接把模型丢进 2D/ 就能用，不再依赖手动运行 AI_set_live2d.py。
function syncedMotionConfig(character, kind) {
  const { config, changed } = mergeMotionConfig(kind, character, readMotionConfig(character, kind));
  if (changed) { writeMotionConfig(character, kind, config); notifyDesktopReload(); }
  return config;
}

function motionData(character) {
  const name = String(character || '');
  if (!name || name.startsWith('[VRM] ') || !isLive2DModelDir(name)) return { character: name, actions: {}, expressions: {} };
  return { character: name, actions: syncedMotionConfig(name, 'actions'), expressions: syncedMotionConfig(name, 'expressions') };
}

function environmentInfo() {
  const ttsHub = path.resolve(__dirname, '..', 'full-hub', 'tts-hub');
  let hasLocalTts = false;
  try { hasLocalTts = fs.statSync(ttsHub).isDirectory() && fs.readdirSync(ttsHub, { withFileTypes: true }).some(entry => entry.isDirectory()); } catch {}
  const currentConfig = readJson(configPath, {});
  return { edition: hasLocalTts ? 'local' : 'cloud', editionLabel: hasLocalTts ? 'Local' : 'Cloud', version: currentConfig.version || '' };
}

function listMcpTools() {
  const dir = path.join(__dirname, 'mcp', 'tools');
  const tools = [];
  if (fs.existsSync(dir)) {
    for (const file of fs.readdirSync(dir)) {
      if (!/\.(js|txt)$/i.test(file) || file.toLowerCase() === 'index.js') continue;
      const fullPath = path.join(dir, file);
      if (!fs.statSync(fullPath).isFile()) continue;
      let description = '';
      try { description = fs.readFileSync(fullPath, 'utf8').slice(0, 500).match(/\/\*\*\s*\n?\s*\*?\s*([^\n*]+)/)?.[1]?.trim() || ''; } catch {}
      tools.push({ type: 'local', key: file, name: file.replace(/\.(js|txt)$/i, ''), enabled: file.endsWith('.js'), description });
    }
  }
  const mcpConfig = readJson(path.join(__dirname, 'mcp', 'mcp_config.json'), {});
  const localNames = new Set(tools.map(tool => tool.name));
  for (const [key, value] of Object.entries(mcpConfig)) {
    const name = key.endsWith('_disabled') ? key.slice(0, -9) : key;
    const isLocal = (value.args || []).some(arg => typeof arg === 'string' && arg.includes('./mcp/tools/'));
    if (!isLocal && !localNames.has(name)) tools.push({ type: 'external', key, name, enabled: !key.endsWith('_disabled'), description: `External tool · ${value.command || ''}` });
  }
  return tools.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
}

function createControlWindow() {
  const win = controlWindow = new BrowserWindow({
    width: 1080,
    height: 760,
    minWidth: 860,
    minHeight: 620,
    frame: false,
    show: false,
    opacity: 0,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'control-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      // 全屏透明的桌宠窗口抢鼠标时，系统会误判面板被完全遮挡而停止绘制，日志收到了也不刷新
      backgroundThrottling: false
    }
  });
  const fadeWindow = (from, to, duration = 320) => new Promise(resolve => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (win.isDestroyed()) {
        clearInterval(timer);
        resolve();
        return;
      }
      const progress = Math.min(1, (Date.now() - startedAt) / duration);
      const eased = progress * progress * (3 - 2 * progress);
      win.setOpacity(from + (to - from) * eased);
      if (progress >= 1) {
        clearInterval(timer);
        resolve();
      }
    }, 16);
  });
  let closing = false;
  let configDirty = false;
  win.once('ready-to-show', () => {
    win.show();
    fadeWindow(0, 1);
  });
  win.on('close', event => {
    if (closing) return;
    event.preventDefault();
    if (configDirty) {
      win.webContents.send('control:close-requested');
      return;
    }
    closing = true;
    const autoCloseServices = readJson(configPath, {}).auto_close_services?.enabled ?? true;
    Promise.all([fadeWindow(win.getOpacity(), 0, 260), stopLive2dProcess(),
      autoCloseServices ? stopConfiguredServices() : Promise.resolve()])
      .finally(() => { if (!win.isDestroyed()) win.destroy(); });
  });
  win.loadFile('control.html');
  ipcMain.on('control:config-dirty', (event, dirty) => {
    if (event.sender === win.webContents) configDirty = Boolean(dirty);
  });
  let pluginWatcher = null;
  try {
    let refreshTimer = null;
    pluginWatcher = fs.watch(pluginsPath, { recursive: true }, () => {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        if (!win.isDestroyed()) win.webContents.send('control:plugins-changed');
      }, 350);
    });
  } catch {}
  win.once('closed', () => pluginWatcher?.close());
}

async function stopLive2dProcess() {
  if (!live2dProcess || live2dProcess.exitCode !== null) {
    live2dProcess = null;
    return { ok: false, message: 'The pet is not running' };
  }
  await postDesktop('/prepare-close', {}, 1800);
  const pid = live2dProcess.pid;
  return new Promise(resolve => {
    const killer = spawn('taskkill.exe', ['/pid', String(pid), '/t', '/f'], { windowsHide: true });
    killer.on('error', error => resolve({ ok: false, message: `Failed to close: ${error.message}` }));
    killer.on('exit', code => {
      if (code === 0) {
        live2dProcess = null;
        resolve({ ok: true, message: 'Pet closed' });
      } else {
        resolve({ ok: false, message: `Failed to close (${code})` });
      }
    });
  });
}

ipcMain.handle('control:window', (event, action) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  if (action === 'minimize') win.minimize();
  if (action === 'maximize') win.isMaximized() ? win.unmaximize() : win.maximize();
  if (action === 'close') win.close();
});

ipcMain.handle('control:confirm-unsaved-config', async (event, title = 'Unsaved config') => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showMessageBox(win, {
    type: 'warning',
    title,
    message: 'The config has unsaved changes. If you continue, they may not take effect.',
    detail: 'Save the current config?',
    buttons: ['Save', 'Discard', 'Cancel'],
    defaultId: 0,
    cancelId: 2,
    noLink: true
  });
  return ['save', 'discard', 'cancel'][result.response] || 'cancel';
});

ipcMain.handle('control:open-github', () => shell.openExternal('https://github.com/morettt/my-neuro'));
ipcMain.handle('control:reset-model-position', async () => {
  const current = readJson(configPath, {});
  current.ui ||= {};
  current.ui.model_position ||= {};
  Object.assign(current.ui.model_position, { x: 1.35, y: 0.8, remember_position: true });
  current.ui.model_scale = 0.65;
  fs.writeFileSync(configPath, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
  const result = await postDesktop('/reset-model-position', {});
  return result.success ? { ok: true, message: 'Avatar position reset' } : { ok: true, message: 'Avatar position saved. It applies when the pet starts' };
});
ipcMain.handle('control:adjust-subtitle-position', async () => {
  const result = await postDesktop('/adjust-subtitle-position', {});
  return result.success ? { ok: true, message: 'Subtitle adjust mode is on' } : { ok: false, message: 'Start the pet first, then adjust the subtitle position' };
});
ipcMain.handle('control:select-voice-file', async (_event, kind) => {
  const isModel = kind === 'model';
  const result = await dialog.showOpenDialog({ properties: ['openFile'], filters: isModel
    ? [{ name: 'PyTorch model', extensions: ['pth'] }]
    : [{ name: 'Audio file', extensions: ['wav'] }] });
  if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true };
  const source = result.filePaths[0];
  const targetDir = path.join(__dirname, 'Voice_Model_Factory');
  fs.mkdirSync(targetDir, { recursive: true });
  const target = path.join(targetDir, path.basename(source));
  fs.copyFileSync(source, target);
  if (isModel) selectedVoiceModelPath = target;
  else selectedVoiceAudioPath = target;
  return { ok: true, filename: path.basename(target) };
});
ipcMain.handle('control:generate-voice-bat', (_event, options) => {
  const character = String(options?.character || '').trim();
  const text = String(options?.text || '').trim();
  const language = ['zh', 'en', 'ja'].includes(options?.language) ? options.language : 'zh';
  if (!character || !text) return { ok: false, message: 'Enter the character name and the reference text' };
  if (!selectedVoiceModelPath || !fs.existsSync(selectedVoiceModelPath)) return { ok: false, message: 'Choose a model file first' };
  if (!selectedVoiceAudioPath || !fs.existsSync(selectedVoiceAudioPath)) return { ok: false, message: 'Choose a reference audio file first' };
  const safeName = character.replace(/[<>:"/\\|?*]/g, '_');
  const escapedText = text.replace(/"/g, '""');
  const batPath = path.join(__dirname, 'Voice_Model_Factory', `${safeName}_TTS.bat`);
  const content = ['@echo off', 'set "PATH=%~dp0..\\..\\full-hub\\tts-hub\\GPT-SoVITS-Bundle\\runtime;%PATH%"',
    'cd /d "%~dp0..\\..\\full-hub\\tts-hub\\GPT-SoVITS-Bundle"',
    `python api.py -p 5000 -d cuda -s "${selectedVoiceModelPath}" -dr "${selectedVoiceAudioPath}" -dt "${escapedText}" -dl ${language}`, 'pause', ''].join('\r\n');
  fs.writeFileSync(batPath, content, 'utf8');
  return { ok: true, message: `Created: ${path.basename(batPath)}` };
});
ipcMain.handle('control:service-status', () => serviceStatus());
ipcMain.handle('control:start-service', async (event, id) => {
  const definition = serviceLaunchDefinition(id);
  if (!definition) return { ok: false, message: 'Unknown service' };
  if (!serviceInstalled(definition)) return { ok: false, message: `${definition.name} is not installed yet` };
  if (await portListening(definition.port)) return { ok: false, message: `${definition.name} is already running` };
  const batPath = path.join(projectRoot, definition.bat);
  if (!fs.existsSync(batPath)) return { ok: false, message: `Cannot find ${definition.bat}` };
  sendServiceLog(event.sender, id, `Starting ${definition.name}...\n`);
  const child = spawn('cmd.exe', ['/d', '/c', batPath], { cwd: projectRoot, windowsHide: true });
  serviceProcesses[id] = child;
  child.stdout.on('data', chunk => sendServiceLog(event.sender, id, chunk));
  child.stderr.on('data', chunk => sendServiceLog(event.sender, id, chunk));
  child.on('error', error => sendServiceLog(event.sender, id, `Failed to start: ${error.message}\n`));
  child.on('exit', code => {
    if (serviceProcesses[id] === child) serviceProcesses[id] = null;
    sendServiceLog(event.sender, id, `\n${definition.name} process exited (${code ?? 'unknown'})\n`);
    if (!event.sender.isDestroyed()) event.sender.send('control:service-state');
  });
  return { ok: true, message: `${definition.name} is starting` };
});
ipcMain.handle('control:stop-service', async (event, id) => {
  const definition = serviceDefinitions[id];
  if (!definition) return { ok: false, message: 'Unknown service' };
  const pids = await listeningPids(definition.port);
  const tracked = serviceProcesses[id];
  if (tracked?.pid) pids.push(String(tracked.pid));
  const uniquePids = [...new Set(pids)];
  if (!uniquePids.length) return { ok: false, message: `${definition.name} is not running` };
  sendServiceLog(event.sender, id, `Stopping ${definition.name}...\n`);
  if (id === 'bert') {
    try {
      await net.fetch('http://127.0.0.1:6007/shutdown', {
        method: 'POST',
        signal: AbortSignal.timeout(1500)
      });
      await new Promise(resolve => setTimeout(resolve, 500));
      if (!(await portListening(definition.port))) {
        serviceProcesses[id] = null;
        sendServiceLog(event.sender, id, `${definition.name} stopped\n`);
        return { ok: true, message: `${definition.name} stopped` };
      }
    } catch (_) {
      // 旧版 BERT 服务没有退出接口时，继续使用进程结束兜底。
    }
  }
  const stopResults = await Promise.allSettled(uniquePids.map(pid =>
    runProcess('taskkill.exe', ['/pid', pid, '/t', '/f'])
  ));
  await new Promise(resolve => setTimeout(resolve, 300));
  let remainingPids = await listeningPids(definition.port);
  if (remainingPids.length) {
    await Promise.allSettled(remainingPids.map(pid =>
      runProcess('taskkill.exe', ['/pid', pid, '/f'])
    ));
    await new Promise(resolve => setTimeout(resolve, 500));
    remainingPids = await listeningPids(definition.port);
  }
  if (remainingPids.length) {
    const errors = stopResults
      .filter(result => result.status === 'rejected')
      .map(result => result.reason?.message)
      .filter(Boolean)
      .join('; ');
    const message = `${definition.name} could not be stopped: port ${definition.port} is still used by PID ${remainingPids.join(', ')}${errors ? `: ${errors}` : ''}`;
    sendServiceLog(event.sender, id, `${message}\n`);
    return { ok: false, message };
  }
  serviceProcesses[id] = null;
  sendServiceLog(event.sender, id, `${definition.name} stopped\n`);
  return { ok: true, message: `${definition.name} stopped` };
});
ipcMain.handle('control:download-service', async (event, id) => {
  const definition = serviceDefinitions[id];
  if (!definition) return { ok: false, message: 'Unknown service' };
  if (serviceInstalled(definition)) return { ok: false, message: `${definition.name} is already installed` };
  if (serviceDownloads[id]) return { ok: false, message: `${definition.name} is downloading` };
  const script = path.join(hubRoot, 'Batch_Download.py');
  if (!fs.existsSync(script)) return { ok: false, message: 'Cannot find Batch_Download.py' };
  sendServiceLog(event.sender, id, `Downloading the ${definition.name} module...\n`);
  serviceDownloads[id] = { exitCode: null };
  if (!event.sender.isDestroyed()) event.sender.send('control:service-state');
  let pythonExecutable;
  try {
    pythonExecutable = await ensureProjectPython(event.sender, id);
  } catch (error) {
    serviceDownloads[id] = null;
    sendServiceLog(event.sender, id, `Failed to install the project Python environment: ${error.message}\n`);
    if (!event.sender.isDestroyed()) event.sender.send('control:service-state');
    return { ok: false, message: `Failed to install the project Python environment: ${error.message}` };
  }
  const child = spawn(pythonExecutable, ['-u', script, definition.flag], {
    cwd: hubRoot,
    windowsHide: true,
    env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', MY_NEURO_FULL_HUB_DIR: hubRoot }
  });
  serviceDownloads[id] = child;
  child.stdout.on('data', chunk => sendServiceLog(event.sender, id, chunk));
  child.stderr.on('data', chunk => sendServiceLog(event.sender, id, chunk));
  child.on('error', error => sendServiceLog(event.sender, id, `Failed to start the download: ${error.message}\n`));
  child.on('exit', code => {
    serviceDownloads[id] = null;
    sendServiceLog(event.sender, id, `\nDownload process ended (${code ?? 'unknown'})\n`);
    if (!event.sender.isDestroyed()) event.sender.send('control:service-state');
  });
  return { ok: true, message: `Started downloading ${definition.name}` };
});
ipcMain.handle('control:open-external', (_event, url) => {
  if (!/^https?:\/\//i.test(url)) throw new Error('Unsupported link');
  return shell.openExternal(url);
});
ipcMain.handle('control:list-plugins', () => listPlugins());
ipcMain.handle('control:refresh-plugin-market', () => refreshPluginMarket());
ipcMain.handle('control:set-plugin-enabled', (_event, relPath, enabled) => {
  if (!/^(built-in|community)\/[\w.-]+$/.test(relPath)) throw new Error('Invalid plugin path');
  const file = path.join(pluginsPath, 'enabled_plugins.json');
  const current = new Set(readJson(file, { plugins: [] }).plugins || []);
  enabled ? current.add(relPath) : current.delete(relPath);
  fs.writeFileSync(file, `${JSON.stringify({ plugins: [...current] }, null, 2)}\n`, 'utf8');
  return { ok: true };
});
ipcMain.handle('control:save-plugin-config', (_event, type, name, pluginConfig) => {
  if (!/^(built-in|community)$/.test(type) || !/^[\w.-]+$/.test(name)) throw new Error('Invalid plugin name');
  const file = path.join(pluginsPath, type, name, 'plugin_config.json');
  if (!fs.existsSync(path.dirname(file))) throw new Error('Plugin not found');
  fs.writeFileSync(file, `${JSON.stringify(pluginConfig, null, 2)}\n`, 'utf8');
  return { ok: true };
});
ipcMain.handle('control:read-plugin-readme', (_event, type, name) => {
  if (!/^(built-in|community)$/.test(type) || !/^[\w.-]+$/.test(name)) throw new Error('Invalid plugin name');
  const file = path.join(pluginsPath, type, name, 'README.md');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
});
ipcMain.handle('control:install-plugin', async (_event, id, repo) => {
  try { return await installPluginArchive(id, repo); }
  catch (error) { return { ok: false, message: `Install failed: ${error.message}` }; }
});
ipcMain.handle('control:install-plugin-dlc', async (_event, name, url) => {
  if (!/^[\w.-]+$/.test(name) || !/^https:\/\//i.test(url)) return { ok: false, message: 'DLC info is invalid' };
  const target = path.join(__dirname, 'plugins-dlc', name);
  const temp = fs.mkdtempSync(path.join(app.getPath('temp'), 'my-neuro-dlc-'));
  const zipFile = path.join(temp, 'dlc.zip');
  try {
    await downloadFile(url, zipFile);
    await expandZip(zipFile, target);
    return { ok: true, message: 'DLC installed' };
  } catch (error) { return { ok: false, message: `DLC install failed: ${error.message}` }; }
  finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
ipcMain.handle('control:launch-plugin-bat', (_event, name, bat) => {
  if (!/^[\w.-]+$/.test(name) || typeof bat !== 'string') return { ok: false, message: 'Invalid launch info' };
  const root = path.resolve(__dirname, 'plugins-dlc', name);
  const file = path.resolve(root, bat);
  if (!file.startsWith(`${root}${path.sep}`) || !fs.existsSync(file)) return { ok: false, message: 'The plugin launch file was not found' };
  spawn('cmd.exe', ['/d', '/c', 'start', '', file], { cwd: path.dirname(file), windowsHide: true, detached: true }).unref();
  return { ok: true, message: 'Plugin started' };
});

ipcMain.handle('control:load-config', () => loadControlConfig());
ipcMain.handle('control:get-chat-history', () => {
  const file = path.join(projectRoot, 'AI记录室', '对话历史.jsonl');
  if (!fs.existsSync(file)) return { exists: false, file, messages: [], invalidLines: 0 };
  const messages = [];
  let invalidLines = 0;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const message = JSON.parse(line);
      message.history_images = (Array.isArray(message.attachments) ? message.attachments : [])
        .filter(item => item?.type === 'image' && typeof item.path === 'string')
        .map(item => {
          const imageRoot = path.join(projectRoot, 'AI记录室', '对话截图');
          const imagePath = path.resolve(path.join(projectRoot, 'AI记录室'), item.path);
          if (!imagePath.startsWith(`${imageRoot}${path.sep}`) || !fs.existsSync(imagePath)) return null;
          const mime = path.extname(imagePath).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg';
          return `data:${mime};base64,${fs.readFileSync(imagePath).toString('base64')}`;
        })
        .filter(Boolean);
      messages.push(message);
    } catch { invalidLines += 1; }
  }
  return { exists: true, file, messages, invalidLines };
});
ipcMain.handle('control:environment-info', () => environmentInfo());
ipcMain.handle('control:get-prompts', async () => {
  const response = await net.fetch('http://mynewbot.com/api/get-prompts');
  if (!response.ok) throw new Error(`Prompt API request failed (${response.status})`);
  const data = await response.json();
  if (!data.success) throw new Error(data.message || 'Failed to get the prompt list');
  return Array.isArray(data.prompts) ? data.prompts : [];
});
ipcMain.handle('control:fetch-llm-models', async (_event, apiUrl, apiKey) => {
  let endpoint = String(apiUrl || '').trim().replace(/\/+$/, '');
  if (!endpoint) throw new Error('Enter the API URL first');
  for (const suffix of ['/chat/completions', '/completions', '/responses', '/models']) {
    if (endpoint.toLowerCase().endsWith(suffix)) { endpoint = endpoint.slice(0, -suffix.length).replace(/\/+$/, ''); break; }
  }
  endpoint += '/models';
  const headers = { Accept: 'application/json' };
  if (String(apiKey || '').trim()) headers.Authorization = `Bearer ${String(apiKey).trim()}`;
  let response;
  try { response = await net.fetch(endpoint, { headers, signal: AbortSignal.timeout(28000) }); }
  catch (error) { throw new Error(`Could not connect to the model API: ${error.message}`); }
  let payload = {};
  try { payload = await response.json(); } catch { throw new Error(`The model API did not return JSON (HTTP ${response.status})`); }
  if (!response.ok) throw new Error(payload?.error?.message ? `HTTP ${response.status}: ${payload.error.message}` : `Fetch failed (HTTP ${response.status})`);
  const items = Array.isArray(payload) ? payload : payload.data;
  if (!Array.isArray(items)) throw new Error('Unsupported API response: no model list found');
  const models = [...new Set(items.map(item => typeof item === 'object' ? (item.id || item.name) : item).filter(Boolean).map(String))].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
  if (!models.length) throw new Error('The API answered, but the model list is empty');
  return models;
});
ipcMain.handle('control:test-llm-model', async (_event, apiUrl, apiKey, model) => {
  let endpoint = String(apiUrl || '').trim().replace(/\/+$/, '');
  if (!endpoint || !String(model || '').trim()) return { ok: false, message: 'Enter the API URL and choose a model first' };
  for (const suffix of ['/chat/completions', '/completions', '/responses', '/models']) {
    if (endpoint.toLowerCase().endsWith(suffix)) { endpoint = endpoint.slice(0, -suffix.length).replace(/\/+$/, ''); break; }
  }
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (String(apiKey || '').trim()) headers.Authorization = `Bearer ${String(apiKey).trim()}`;
  const started = performance.now();
  const signal = AbortSignal.timeout(30000);
  try {
    // 🔥 默认关闭思考模式，避免测出来的延迟被思考过程拉高
    const requestBody = {
      model: String(model).trim(),
      messages: [{ role: 'user', content: 'Reply with only OK' }],
      stream: true,
      thinking: { type: 'disabled' }
    };
    const response = await net.fetch(`${endpoint}/chat/completions`, {
      method: 'POST', headers, signal,
      body: JSON.stringify(requestBody)
    });
    if (!response.ok) {
      let detail;
      try { detail = (await response.json())?.error?.message; } catch { /* 忽略非 JSON 错误体 */ }
      const message = String(detail || 'Model request failed').slice(0, 240);
      const key = String(apiKey || '').trim();
      return { ok: false, message: `HTTP ${response.status}: ${key ? message.split(key).join('***') : message}` };
    }

    // 🔥 实际对话走的是流式响应，这里测的也应是首个正文 token 的到达时间（TTFT），
    // 而不是等完整回复——开了思考模式的模型完整回复耗时会被思考过程严重拉高，
    // 跟用户真实感知到的延迟对不上。
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let firstTokenMs = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === 'data: [DONE]' || trimmed === 'data:[DONE]' || !trimmed.startsWith('data:')) continue;
        const jsonStr = trimmed.startsWith('data: ') ? trimmed.slice(6) : trimmed.slice(5);
        let chunk;
        try { chunk = JSON.parse(jsonStr); } catch { continue; }
        if (chunk?.choices?.[0]?.delta?.content) {
          firstTokenMs = Math.round(performance.now() - started);
          break;
        }
      }
      if (firstTokenMs !== null) { try { await reader.cancel(); } catch { /* 已拿到结果，忽略取消失败 */ } break; }
    }

    if (firstTokenMs === null) return { ok: false, message: 'The API returned no text reply' };
    return { ok: true, elapsedMs: firstTokenMs };
  } catch {
    return { ok: false, message: signal.aborted ? 'Test timed out (30 seconds), could not confirm it works' : 'Connection failed. Check the API URL and your network' };
  }
});
ipcMain.handle('control:list-mcp-tools', () => listMcpTools());
ipcMain.handle('control:toggle-mcp-tool', (_event, type, key) => {
  if (type === 'local') {
    if (!/^[\w.-]+\.(js|txt)$/.test(key) || key.toLowerCase() === 'index.js') throw new Error('Invalid tool file');
    const oldPath = path.join(__dirname, 'mcp', 'tools', key);
    if (!fs.existsSync(oldPath)) throw new Error('Tool file not found');
    const newKey = key.endsWith('.js') ? `${key.slice(0, -3)}.txt` : `${key.slice(0, -4)}.js`;
    fs.renameSync(oldPath, path.join(__dirname, 'mcp', 'tools', newKey));
  } else if (type === 'external') {
    const file = path.join(__dirname, 'mcp', 'mcp_config.json');
    const data = readJson(file, {});
    if (!(key in data)) throw new Error('External tool not found');
    const newKey = key.endsWith('_disabled') ? key.slice(0, -9) : `${key}_disabled`;
    data[newKey] = data[key]; delete data[key];
    fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  } else throw new Error('Invalid tool type');
  return { ok: true };
});
ipcMain.handle('control:get-tool-market', async () => {
  const response = await net.fetch('http://mynewbot.com/api/get-tools');
  if (!response.ok) throw new Error(`Tool API request failed (${response.status})`);
  const data = await response.json();
  if (!data.success) throw new Error(data.message || 'Failed to get the tool list');
  return Array.isArray(data.tools) ? data.tools : [];
});
ipcMain.handle('control:download-tool', async (_event, tool) => {
  const id = String(tool?.id || '');
  const filename = path.basename(String(tool?.file_name || ''));
  if (!id || !filename || !/\.(js|txt)$/i.test(filename)) throw new Error('Invalid tool info');
  const response = await net.fetch(`http://mynewbot.com/api/download-tool/${encodeURIComponent(id)}`);
  if (!response.ok) throw new Error(`Download failed (HTTP ${response.status})`);
  fs.mkdirSync(path.join(__dirname, 'mcp', 'tools'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'mcp', 'tools', filename), Buffer.from(await response.arrayBuffer()));
  return { ok: true, filename };
});

ipcMain.handle('control:save-config', (_event, config) => {
  saveControlConfig(config);
  return { ok: true };
});

ipcMain.handle('control:list-live2d-models', () => [
  ...scanLive2DModels().map(model => model.name),
  ...scanVRMModels().map(model => `[VRM] ${model.name}`)
]);
ipcMain.handle('control:current-live2d-model', () => {
  const currentConfig = readJson(configPath, {});
  if (currentConfig.ui?.model_type === 'vrm') {
    const configured = currentConfig.ui?.vrm_model;
    const model = scanVRMModels().find(item => item.name === configured) || scanVRMModels()[0];
    return model ? `[VRM] ${model.name}` : '';
  }
  return resolveLive2DModel(currentConfig.ui?.live2d_model).entry?.name || '';
});
ipcMain.handle('control:select-live2d-model', async (_event, name) => {
  const isVrm = name.startsWith('[VRM] ');
  const modelName = isVrm ? name.slice(6) : name;
  const targetType = isVrm ? 'vrm' : 'live2d';
  const vrmEntry = isVrm ? scanVRMModels().find(model => model.name === modelName) : null;
  if (isVrm ? !vrmEntry : !scanLive2DModels().some(model => model.name === modelName)) throw new Error('Model not found');
  const currentConfig = readJson(configPath, {});
  const activeType = currentConfig.ui?.model_type === 'vrm' ? 'vrm' : 'live2d';
  const modelResult = await postDesktop('/set-avatar-model', { type: targetType, model_name: modelName }, 20000);
  let switchResult = modelResult;
  if (modelResult.success && activeType !== targetType) {
    switchResult = await postDesktop('/switch-avatar-type', { type: targetType }, 30000);
  }
  currentConfig.ui ||= {};
  currentConfig.ui.model_type = targetType;
  if (isVrm) {
    currentConfig.ui.vrm_model = vrmEntry.name;
    currentConfig.ui.vrm_model_path = vrmEntry.modelPath;
  } else {
    currentConfig.ui.live2d_model = modelName;
    currentConfig.ui.vrm_model = '';
    currentConfig.ui.vrm_model_path = '';
  }
  fs.writeFileSync(configPath, `${JSON.stringify(currentConfig, null, 2)}\n`, 'utf8');
  if (switchResult.success) return { ok: true, hotReloaded: true, message: `Switched to ${name}` };
  return { ok: true, hotReloaded: false, message: `Selected ${name}. The pet is not running, so it applies the next time it starts` };
});
ipcMain.handle('control:load-motion-data', (_event, character) => motionData(character));
ipcMain.handle('control:save-motion-data', async (_event, character, kind, values) => {
  if (!character || !['actions', 'expressions'].includes(kind)) throw new Error('Invalid motion config');
  writeMotionConfig(character, kind, values);
  await notifyDesktopReload();
  return { ok: true };
});
ipcMain.handle('control:reset-motion-data', async (_event, character, kind) => {
  if (!['actions', 'expressions'].includes(kind) || !isLive2DModelDir(character)) return { ok: false, message: 'This model has no config to restore' };
  // AI_set_live2d.py 写表情备份时用的键名是 original_config1，动作备份才是 original_config
  const backupFile = kind === 'actions' ? 'character_backups.json' : 'character_backups1.json';
  const backupKey = kind === 'actions' ? 'original_config' : 'original_config1';
  const original = readJson(path.join(__dirname, backupFile), {})[character]?.[backupKey]?.[motionRootKey(kind)];
  // 没有备份（例如手动放进来的新模型）时，直接按模型目录重新生成默认配置；有备份也过一遍合并，剔除已不存在的文件
  writeMotionConfig(character, kind, mergeMotionConfig(kind, character, original || {}).config);
  await notifyDesktopReload();
  return { ok: true, message: original ? 'Original config restored' : 'No backup found, so the default config was rebuilt from the model files' };
});
ipcMain.handle('control:trigger-motion', (_event, name) => postDesktop('/control-motion', { action: 'trigger_emotion', emotion_name: name }));
ipcMain.handle('control:trigger-expression', (_event, name) => postDesktop('/control-expression', { action: 'trigger_expression', expression_name: name }));
ipcMain.handle('control:apply-vmc', async (_event, host, port) => {
  const current = readJson(configPath, {}); current.vmc ||= {}; current.vmc.host = host || '127.0.0.1'; current.vmc.port = Number(port) || 39539;
  fs.writeFileSync(configPath, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
  if (!live2dProcess || live2dProcess.exitCode !== null) return { success: true, message: 'VMC address saved. It applies when the pet starts' };
  return postDesktop('/control-vmc', { host: current.vmc.host, port: current.vmc.port });
});

ipcMain.handle('control:start-live2d', event => {
  if (live2dProcess && live2dProcess.exitCode === null) return { ok: false, message: 'The pet is already running' };
  startRuntimeLog(event.sender);
  showAvatarLoadingWindow();
  live2dProcess = spawn('cmd.exe', ['/d', '/c', 'go.bat'], {
    cwd: __dirname,
    windowsHide: true
  });
  live2dProcess.stdout.on('data', () => {});
  live2dProcess.stderr.on('data', () => {});
  live2dProcess.on('exit', code => {
    closeAvatarLoadingWindow();
    stopRuntimeLog();
    if (!event.sender.isDestroyed()) {
      event.sender.send('control:tool-log', `Pet process exited (${code ?? 'unknown'})\n`);
      event.sender.send('control:live2d-state', false);
    }
    live2dProcess = null;
  });
  return { ok: true, message: 'Starting the pet' };
});

ipcMain.handle('control:stop-live2d', async () => {
  return stopLive2dProcess();
});

app.whenReady().then(createControlWindow);
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
