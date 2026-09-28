import os
import json
import shutil
import zipfile
import time

import requests
import sys
import urllib3
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
import platform
import subprocess

system = platform.system()

version_tag = "v6.7"

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

current_dir = os.environ.get('MY_NEURO_FULL_HUB_DIR') or os.path.dirname(os.path.abspath(__file__))
current_dir = os.path.abspath(current_dir)
os.makedirs(current_dir, exist_ok=True)

MAX_RETRY = 3
RETRY_WAIT = 5


def display_progress_bar(percent, message="", mb_downloaded=None, mb_total=None, current=None, total=None):
    bar_length = 40
    filled_length = int(bar_length * percent / 100)
    bar = '█' * filled_length + '-' * (bar_length - filled_length)
    extra_info = ""
    if mb_downloaded is not None and mb_total is not None:
        extra_info = f" ({mb_downloaded:.2f}MB/{mb_total:.2f}MB)"
    elif current is not None and total is not None:
        extra_info = f" ({current}/{total} files)"
    sys.stdout.write(f"\r{message}: |{bar}| {percent}% done{extra_info}")
    sys.stdout.flush()


def download_file(url, file_name=None):
    if file_name is None:
        file_name = url.split('/')[-1]
    print(f"Downloading: {file_name}...")
    session = requests.Session()
    retry_strategy = Retry(
        total=3,
        status_forcelist=[429, 500, 502, 503, 504],
        allowed_methods=["HEAD", "GET", "OPTIONS"]
    )
    adapter = HTTPAdapter(max_retries=retry_strategy)
    session.mount("http://", adapter)
    session.mount("https://", adapter)
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    }
    try:
        response = session.get(url, stream=True, headers=headers, timeout=30)
    except requests.exceptions.SSLError:
        print("SSL verification failed, retrying in insecure mode...")
        response = session.get(url, stream=True, headers=headers, timeout=30, verify=False)
    # 镜像返回 404/5xx 时必须抛错，否则错误页会被当成压缩包保存，多源切换也不会触发
    response.raise_for_status()
    total_size = int(response.headers.get('content-length', 0))
    downloaded_size = 0
    with open(file_name, 'wb') as file:
        for chunk in response.iter_content(chunk_size=1024 * 1024):
            if chunk:
                file.write(chunk)
                downloaded_size += len(chunk)
                percent = int(downloaded_size * 100 / total_size) if total_size > 0 else 0
                mb_downloaded = downloaded_size / (1024 * 1024)
                mb_total = total_size / (1024 * 1024)
                display_progress_bar(percent, "Download progress", mb_downloaded=mb_downloaded, mb_total=mb_total)
    print("\nDownload finished!")
    return file_name


def extract_zip(zip_file, target_folder):
    print(f"Extracting {zip_file} to {target_folder}...")
    if not os.path.exists(target_folder):
        os.makedirs(target_folder)
    try:
        with zipfile.ZipFile(zip_file, 'r') as zip_ref:
            file_list = zip_ref.namelist()
            total_files = len(file_list)
            for index, file in enumerate(file_list):
                try:
                    correct_filename = file.encode('cp437').decode('gbk')
                    target_path = os.path.join(target_folder, correct_filename)
                    if os.path.dirname(target_path) and not os.path.exists(os.path.dirname(target_path)):
                        os.makedirs(os.path.dirname(target_path), exist_ok=True)
                    data = zip_ref.read(file)
                    if not correct_filename.endswith('/'):
                        with open(target_path, 'wb') as f:
                            f.write(data)
                except Exception:
                    zip_ref.extract(file)
                    if os.path.exists(file):
                        target_path = os.path.join(target_folder, file)
                        if os.path.dirname(target_path) and not os.path.exists(os.path.dirname(target_path)):
                            os.makedirs(os.path.dirname(target_path), exist_ok=True)
                        shutil.move(file, target_path)
                percent = int((index + 1) * 100 / total_files)
                display_progress_bar(percent, "Extract progress", current=index + 1, total=total_files)
        print("\nExtraction finished!")
        return True
    except zipfile.BadZipFile:
        print("Error: the downloaded file is not a valid ZIP file")
        return False
    except Exception as e:
        print(f"Error while extracting: {e}")
        return False


def extract_7z(archive_file, target_folder):
    print(f"Extracting {archive_file} to {target_folder}...")
    if not os.path.exists(target_folder):
        os.makedirs(target_folder)
    try:
        local_7z = os.path.join(current_dir, "7z", "7z.exe")
        if not os.path.exists(local_7z):
            print("Downloading the 7z tool...")
            sevenz_dir = os.path.join(current_dir, "7z")
            if not os.path.exists(sevenz_dir):
                os.makedirs(sevenz_dir)
            seven_zip_url = "https://www.7-zip.org/a/7zr.exe"
            try:
                response = requests.get(seven_zip_url, timeout=30)
                with open(local_7z, 'wb') as f:
                    f.write(response.content)
                print("7z tool downloaded!")
            except Exception as e:
                print(f"Failed to download 7z: {e}")
                return False
        print('Extracting the TTS model package. This can take a few minutes.......')
        # Capture bytes: 7z output may use a Windows code page even with PYTHONUTF8=1.
        cmd = [local_7z, "x", archive_file, f"-o{target_folder}", "-y"]
        result = subprocess.run(cmd, capture_output=True)
        if result.returncode == 0:
            print("\nExtraction finished!")
            return True
        else:
            print("\nExtraction failed: " + result.stderr.decode("utf-8", errors="replace"))
            return False
    except Exception as e:
        print(f"Error while extracting: {e}")
        return False


def _clear_modelscope_lock(model_id):
    lock_name = model_id.replace('/', '___')
    lock_path = os.path.join(os.path.expanduser('~'), '.cache', 'modelscope', 'hub', '.lock', lock_name)
    if not os.path.exists(lock_path):
        return

    print(f"Found a leftover lock file: {lock_path}", flush=True)

    # 找到占用锁文件的进程并强制终止
    try:
        import psutil
        for proc in psutil.process_iter(['pid', 'name']):
            try:
                for f in proc.open_files():
                    if os.path.normcase(f.path) == os.path.normcase(lock_path):
                        print(f"Stopping the process that holds the lock: PID={proc.pid} ({proc.name()})", flush=True)
                        proc.kill()
                        proc.wait(timeout=5)
                        break
            except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.TimeoutExpired):
                pass
    except ImportError:
        print("psutil is not installed, skipping the process check", flush=True)

    # 重试删除
    for attempt in range(5):
        try:
            os.remove(lock_path)
            print(f"Removed the lock file", flush=True)
            return
        except Exception:
            time.sleep(1)
    print(f"Warning: could not delete the lock file, the download may still hang: {lock_path}", flush=True)


def download_model_direct(model_id, local_dir, revision=None):
    """直接用Python API下载modelscope模型，不依赖CLI命令"""
    from modelscope.hub.snapshot_download import snapshot_download
    _clear_modelscope_lock(model_id)
    print(f"Downloading: {model_id}", flush=True)
    print(f"Saving to: {local_dir}", flush=True)
    os.makedirs(local_dir, exist_ok=True)
    for attempt in range(MAX_RETRY):
        try:
            download_kwargs = {"local_dir": local_dir}
            if revision:
                download_kwargs["revision"] = revision
            snapshot_download(model_id, **download_kwargs)
            print(f"Download finished: {model_id}", flush=True)
            return True
        except Exception as e:
            print(f"Download failed ({attempt + 1}/{MAX_RETRY}): {e}", flush=True)
            if attempt < MAX_RETRY - 1:
                _clear_modelscope_lock(model_id)
                print(f"Retrying in {RETRY_WAIT} seconds...", flush=True)
                time.sleep(RETRY_WAIT)
    return False


# ─────────────────────────────────────────────
# 各模块下载函数
# ─────────────────────────────────────────────

def _live2d_installed_version(target_folder):
    """读取已安装 live-2d 的版本号（与 update.py 相同的约定），读不到返回 None"""
    try:
        with open(os.path.join(target_folder, "config.json"), 'r', encoding='utf-8') as f:
            return json.load(f).get('version')
    except Exception:
        return None


def download_live2d(force=False):
    print("\n========== Download the Live2D model ==========")
    repo_root = os.path.dirname(current_dir)
    target_folder = os.path.join(repo_root, "live-2d")

    # In a git checkout (like this fork), live-2d is already there and has its own changes.
    # Replacing it with the release zip would delete them. Update it with git instead.
    if not force and os.path.isdir(os.path.join(repo_root, ".git")):
        print("live-2d is part of this git checkout, so the release download is skipped.")
        print("Update it with git (see START_HERE.md). --force-live2d replaces it anyway and deletes local changes.")
        return True

    if not force and _live2d_installed_version(target_folder) == version_tag:
        print(f"live-2d is already at version {version_tag} - skipping the download (add --force-live2d to download it again)")
        return True

    download_sources = [
        ('Hong Kong mirror', f'https://hk.gh-proxy.org/https://github.com/morettt/my-neuro/releases/download/{version_tag}/live-2d.zip'),
        ('Backup mirror', f'https://gh-proxy.org/https://github.com/morettt/my-neuro/releases/download/{version_tag}/live-2d.zip'),
        ('GitHub (direct)', f'https://github.com/morettt/my-neuro/releases/download/{version_tag}/live-2d.zip')
    ]
    zip_path = os.path.join(repo_root, 'live-2d.zip')
    downloaded_file = None
    for source_name, url in download_sources:
        try:
            print(f"Trying {source_name} for the download...")
            downloaded_file = download_file(url, zip_path)
            print(f"[OK] {source_name} download succeeded!")
            break
        except Exception as e:
            print(f"[FAIL] {source_name} download failed: {e}")
    if not downloaded_file:
        print("All download sources failed, keeping the current live-2d folder")
        return False

    # 先解压到临时文件夹，全部成功后再替换旧文件夹（与 update.py 的更新策略一致），
    # 避免下载/解压中途失败时用户原有的 live-2d（含配置和记忆数据）已被清空
    temp_folder = os.path.join(repo_root, 'live-2d-temp')
    if os.path.exists(temp_folder):
        shutil.rmtree(temp_folder)
    extract_success = extract_zip(downloaded_file, temp_folder)
    if os.path.exists(downloaded_file):
        os.remove(downloaded_file)
    if not extract_success:
        shutil.rmtree(temp_folder, ignore_errors=True)
        return False

    try:
        if os.path.exists(target_folder):
            shutil.rmtree(target_folder)
        os.rename(temp_folder, target_folder)
    except Exception as e:
        print(f"Failed to replace the live-2d folder (if live-2d is running, close it and try again): {e}")
        if os.path.exists(temp_folder) and not os.path.exists(target_folder):
            os.rename(temp_folder, target_folder)
        return False
    print(f"live-2d {version_tag} downloaded")
    return True


def download_bert():
    print("\n========== Download the BERT model ==========")
    bert_hub_dir = os.path.join(current_dir, "bert-hub")
    omni_key_files = [
        os.path.join(bert_hub_dir, "config.json"),
        os.path.join(bert_hub_dir, "model.safetensors"),
        os.path.join(bert_hub_dir, "vocab.txt"),
    ]
    if all(os.path.exists(f) for f in omni_key_files):
        print("BERT model already exists, skipping the download")
        return True
    print(f"Downloading the BERT model to: {bert_hub_dir}")
    if not download_model_direct("morelle/Omni_fn_bert", bert_hub_dir):
        print("BERT model download failed")
        return False
    print("BERT model downloaded!")
    return True


def download_tts(gpu_type=None):
    print("\n========== Download the TTS model package ==========")
    tts_hub_dir = os.path.join(current_dir, "tts-hub")
    tts_bundle_dir = os.path.join(tts_hub_dir, "GPT-SoVITS-Bundle")
    tts_key_files = [
        os.path.join(tts_bundle_dir, "runtime"),
        os.path.join(tts_bundle_dir, "GPT_SoVITS"),
    ]
    if all(os.path.exists(f) for f in tts_key_files):
        print("TTS model package already exists, skipping the download")
        return True

    if gpu_type is None:
        gpu_type = _detect_gpu_type()

    if gpu_type == '50':
        print("Downloading the TTS package for RTX 50 series cards...")
        model_name = "morelle/fake-neuro-gsv-50"
    else:
        print("Downloading the standard TTS package...")
        model_name = "morelle/fake-neuro-gsv"

    if not download_model_direct(model_name, tts_hub_dir):
        print("TTS model package download failed")
        return False

    bundle_7z_file = os.path.join(tts_hub_dir, "GPT-SoVITS-Bundle.7z")
    if os.path.exists(bundle_7z_file):
        if extract_7z(bundle_7z_file, tts_hub_dir):
            try:
                os.remove(bundle_7z_file)
            except Exception:
                pass
            return True
        else:
            return False
    return True


def download_rag():
    print("\n========== Download the RAG model ==========")
    rag_hub_dir = os.path.join(current_dir, "rag-hub")
    bge_key_files = [
        os.path.join(rag_hub_dir, "config.json"),
        os.path.join(rag_hub_dir, "model.safetensors"),
        os.path.join(rag_hub_dir, "tokenizer.json"),
    ]
    if all(os.path.exists(f) for f in bge_key_files):
        print("RAG model already exists, skipping the download")
        return True
    print(f"Downloading the RAG model to: {rag_hub_dir}")
    if not download_model_direct("BAAI/bge-m3", rag_hub_dir):
        print("RAG model download failed")
        return False
    print("RAG model downloaded!")
    return True


def download_asr():
    print("\n========== Download the ASR models ==========")
    asr_hub_dir = os.path.join(current_dir, "asr-hub")
    os.makedirs(asr_hub_dir, exist_ok=True)
    ok = True

    # VAD模型
    print("\nChecking the VAD model...")
    vad_target_dir = os.path.join(asr_hub_dir, 'model', 'torch_hub')
    vad_model_path = os.path.join(vad_target_dir, "snakers4_silero-vad_master")
    if not os.path.exists(vad_model_path):
        ok = download_model_direct("morelle/my-neuro-vad", vad_target_dir) and ok

    # ASR主模型
    print("\nChecking the main ASR model...")
    asr_model_dir = os.path.join(asr_hub_dir, 'model', 'asr', 'models', 'iic',
                                 'speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch')
    asr_key_files = [os.path.join(asr_model_dir, "config.yaml")]
    if not all(os.path.exists(f) for f in asr_key_files):
        ok = download_model_direct(
            "iic/speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch",
            asr_model_dir) and ok

    # SenseVoice: the default ASR model in this fork (English, Chinese, Japanese, Korean, Cantonese)
    print("\nChecking SenseVoice model...")
    sensevoice_dir = os.path.join(asr_hub_dir, 'model', 'asr', 'models', 'iic', 'SenseVoiceSmall')
    sensevoice_key_files = [os.path.join(sensevoice_dir, "config.yaml"), os.path.join(sensevoice_dir, "model.pt")]
    if not all(os.path.exists(f) for f in sensevoice_key_files):
        ok = download_model_direct("iic/SenseVoiceSmall", sensevoice_dir) and ok

    # 标点模型
    print("\nChecking the punctuation model...")
    punc_model_dir = os.path.join(asr_hub_dir, 'model', 'asr', 'models', 'iic',
                                  'punc_ct-transformer_cn-en-common-vocab471067-large')
    punc_key_files = [os.path.join(punc_model_dir, "config.yaml"), os.path.join(punc_model_dir, "model.pt")]
    if not all(os.path.exists(f) for f in punc_key_files):
        ok = download_model_direct(
            "iic/punc_ct-transformer_cn-en-common-vocab471067-large",
            punc_model_dir,
            revision="v2.0.4") and ok

    if ok:
        print("ASR models downloaded!")
    else:
        print("Some ASR models failed to download")
    return ok


def _detect_gpu_type():
    # wmic 在新版 Windows 11 中已被移除，按顺序尝试多种检测方式
    probes = [
        ['nvidia-smi', '--query-gpu=name', '--format=csv,noheader'],
        ['wmic', 'path', 'win32_VideoController', 'get', 'name'],
        ['powershell', '-NoProfile', '-Command', '(Get-CimInstance Win32_VideoController).Name'],
    ]
    for probe in probes:
        try:
            result = subprocess.run(probe, capture_output=True, text=True, timeout=15)
        except Exception:
            continue
        if result.returncode == 0 and result.stdout.strip():
            names = [l.strip() for l in result.stdout.splitlines()
                     if l.strip() and l.strip() != 'Name']
            print(f"Graphics card found: {' / '.join(names)}")
            return '50' if 'RTX 50' in result.stdout else 'non-50'
    print("Could not detect the graphics card, assuming it is not an RTX 50 series card (for a 50 series card, use --gpu 50)")
    return 'non-50'


# ─────────────────────────────────────────────
# 命令行入口
# ─────────────────────────────────────────────

if __name__ == '__main__':
    import argparse

    parser = argparse.ArgumentParser(description='Download the models my-neuro needs')
    parser.add_argument('--live2d', action='store_true', help='Download the Live2D model')
    parser.add_argument('--bert',   action='store_true', help='Download the BERT model')
    parser.add_argument('--tts',    action='store_true', help='Download the TTS model')
    parser.add_argument('--rag',    action='store_true', help='Download the RAG model')
    parser.add_argument('--asr',    action='store_true', help='Download the ASR models')
    parser.add_argument('--all',    action='store_true', help='Download all models')
    parser.add_argument('--gpu',    default=None, choices=['50', 'non-50'], help='Graphics card type (for TTS)')
    parser.add_argument('--force-live2d', action='store_true', help='live-2d is downloaded again even if it is already the current version')
    args = parser.parse_args()

    run_all = args.all or not any([args.live2d, args.bert, args.tts, args.rag, args.asr])

    results = {}

    def run_module(name, action):
        print(f"@@MODULE_START:{name}", flush=True)
        try:
            ok = bool(action())
        except Exception as exc:
            print(f"@@MODULE_FAIL:{name}", flush=True)
            print(f"{name} download error: {exc}", flush=True)
            return False
        print(f"@@MODULE_{'DONE' if ok else 'FAIL'}:{name}", flush=True)
        return ok

    if run_all or args.live2d:
        results['live2d'] = run_module('live2d', lambda: download_live2d(force=args.force_live2d))
    if run_all or args.bert:
        results['bert'] = run_module('bert', download_bert)
    if run_all or args.tts:
        results['tts'] = run_module('tts', lambda: download_tts(args.gpu))
    if run_all or args.rag:
        results['rag'] = run_module('rag', download_rag)
    if run_all or args.asr:
        results['asr'] = run_module('asr', download_asr)

    failed = [name for name, ok in results.items() if not ok]
    if failed:
        print(f"\nThese modules failed to download: {', '.join(failed)}. Run it again to retry")
        sys.exit(1)

    print("\nAll downloads finished!")
