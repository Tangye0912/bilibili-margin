/**
 * 更新页（v0.61）：检查 → 下载 → 选目录 → 写入 → 重新加载。
 *
 * 浏览器不允许扩展自己改安装位置，所以第 3 步必须由用户亲手选一次文件夹；
 * 记住之后，后台就能在无人在场时把更新写进去。
 */
import { checkRelease, downloadArchive, newerRelease, pickArchive, type ReleaseAsset, type ReleaseInfo } from '../shared/releases';
import { loadSettings } from '../shared/settings';
import { installPackage, isExtensionFolder } from '../shared/installer';
import {
  clearUpdateState, keepOnlyPackage, readDirectory, readPackage, readUpdateState, saveDirectory, savePackage, writeUpdateState,
} from '../shared/update-store';

const $ = <T extends HTMLElement>(id: string) => document.querySelector(id) as T;
const manifest = chrome.runtime.getManifest();

let latest: ReleaseInfo | null = null;
let asset: ReleaseAsset | null = null;
let dir: FileSystemDirectoryHandle | null = null;
let busy = false;

function say(text: string, kind: '' | 'ok' | 'warn' = ''): void {
  const el = $('#status');
  el.textContent = text;
  el.className = `status${kind ? ` ${kind}` : ''}`;
}

function step(id: string, done: boolean): void {
  $(`#${id}`).classList.toggle('done', done);
}

function paint(): void {
  const ready = !!latest && !!asset;
  $<HTMLButtonElement>('#download').hidden = !ready;
  $<HTMLButtonElement>('#pick').hidden = !ready;
  $<HTMLButtonElement>('#install').hidden = !ready;
  $<HTMLAnchorElement>('#release').hidden = !latest;
  if (latest) $<HTMLAnchorElement>('#release').href = latest.url;
}

/** 目录选择器只在桌面版 Chrome / Edge 上有；Firefox 走手动替换 */
function picker(): ((options?: { mode?: string; id?: string }) => Promise<FileSystemDirectoryHandle>) | undefined {
  return (window as unknown as { showDirectoryPicker?: (options?: { mode?: string; id?: string }) => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker;
}

async function check(): Promise<void> {
  if (busy) return;
  busy = true;
  $<HTMLButtonElement>('#check').disabled = true;
  say('正在查询最新正式版…');
  try {
    const info = await checkRelease(true);
    latest = info;
    $('#latest').textContent = info.name || `v${info.tag}`;
    step('s1', true);
    if (!newerRelease(info.tag, manifest.version)) {
      asset = null;
      paint();
      say('当前已是最新正式版。', 'ok');
      return;
    }
    asset = pickArchive(info);
    if (!asset) {
      paint();
      say(`发现新版 v${info.tag}，但这次发布没有附可安装的压缩包，请到发布页手动下载。`, 'warn');
      return;
    }
    $('#pack').textContent = asset.size > 0 ? `${asset.name}（${(asset.size / 1048576).toFixed(1)} MB）` : asset.name;
    paint();
    say(`发现新版 v${info.tag}，下载后写回扩展目录就能生效。`);
  } catch (error) {
    const message = error instanceof Error ? error.message : '检查失败';
    say(message === '可选外部服务已关闭' ? '还没开启「允许外部辅助服务」，开启后才能查询版本。' : `${message}，请稍后重试。`, 'warn');
  } finally {
    busy = false;
    $<HTMLButtonElement>('#check').disabled = false;
  }
}

async function download(): Promise<void> {
  if (busy || !asset || !latest) return;
  busy = true;
  $<HTMLButtonElement>('#download').disabled = true;
  say(`正在下载 ${asset.name}…`);
  try {
    const zip = await downloadArchive(asset);
    await savePackage(latest.tag, zip);
    await keepOnlyPackage(latest.tag);
    await writeUpdateState({ tag: latest.tag, name: latest.name, url: latest.url, at: Date.now(), ready: true });
    $('#pack').textContent = `${asset.name}（已下载）`;
    step('s2', true);
    say('下载完成，选好扩展目录就能安装。', 'ok');
    paint();
  } catch (error) {
    say(`${error instanceof Error ? error.message : '下载失败'}，请稍后重试。`, 'warn');
  } finally {
    busy = false;
    $<HTMLButtonElement>('#download').disabled = false;
  }
}

async function pick(): Promise<void> {
  if (busy) return;
  const choose = picker();
  if (!choose) {
    say('这个浏览器不支持直接写入文件夹，请到发布页手动下载后覆盖扩展文件夹。', 'warn');
    return;
  }
  let handle: FileSystemDirectoryHandle;
  try {
    handle = await choose.call(window, { mode: 'readwrite', id: 'margin-extension' });
  } catch {
    say('没有选择文件夹，目录没有改变。', 'warn');
    return;
  }
  if (!await isExtensionFolder(handle)) {
    say('这个文件夹里没有 manifest.json，可能不是映间的扩展目录。请选当初加载扩展时用的那个文件夹。', 'warn');
    return;
  }
  dir = handle;
  await saveDirectory(handle);
  step('s3', true);
  say('目录已记住，之后的后台更新可以直接写。', 'ok');
  if (latest && await readPackage(latest.tag)) await install();
}

async function install(): Promise<void> {
  if (busy) return;
  if (!dir) {
    say('先选一下扩展安装目录。', 'warn');
    await pick();
    return;
  }
  const tag = latest?.tag ?? (await readUpdateState())?.tag;
  if (!tag) {
    say('没有可安装的更新包，先点「检查更新」。', 'warn');
    return;
  }
  const zip = await readPackage(tag);
  if (!zip) {
    say('还没有下载更新包。', 'warn');
    return;
  }
  busy = true;
  $<HTMLButtonElement>('#install').disabled = true;
  say('正在写入扩展目录…');
  try {
    const result = await installPackage(dir, zip, tag);
    step('s4', true);
    await clearUpdateState();
    try { await chrome.action.setBadgeText({ text: '' }); } catch { /* 角标清不掉也不影响。 */ }
    say(`已写入 ${result.files} 个文件，正在重新加载扩展…`, 'ok');
    setTimeout(() => chrome.runtime.reload(), 700);
  } catch (error) {
    say(`${error instanceof Error ? error.message : '写入失败'}，请重试。`, 'warn');
  } finally {
    busy = false;
    $<HTMLButtonElement>('#install').disabled = false;
  }
}

void (async () => {
  $('#cur').textContent = manifest.version_name || manifest.version;
  const settings = await loadSettings();
  const rk = settings.radius === 0 ? 0 : settings.radius === 50 ? 0.5 : settings.radius === 150 ? 1.5 : 1;
  document.documentElement.style.setProperty('--rk', String(rk));
  dir = await readDirectory();
  const state = await readUpdateState();
  if (state) {
    latest = { tag: state.tag, name: state.name, url: state.url, at: state.at };
    $('#latest').textContent = state.name || `v${state.tag}`;
    if (state.ready) {
      asset = { name: '更新包', url: state.url, size: 0 };
      $('#pack').textContent = '已下载';
      step('s1', true);
      step('s2', true);
      paint();
      say('新版已经下载好了，选好扩展目录就能安装。');
      return;
    }
  }
  paint();
  say(settings.privacyExternal ? '可以点「检查更新」看看有没有新版。' : '还没开启「允许外部辅助服务」，开启后才能查询版本。', settings.privacyExternal ? '' : 'warn');
})();

$<HTMLButtonElement>('#check').addEventListener('click', () => { void check(); });
$<HTMLButtonElement>('#download').addEventListener('click', () => { void download(); });
$<HTMLButtonElement>('#pick').addEventListener('click', () => { void pick(); });
$<HTMLButtonElement>('#install').addEventListener('click', () => { void install(); });
