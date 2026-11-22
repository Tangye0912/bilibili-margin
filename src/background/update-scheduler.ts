/**
 * 自动检查更新（v0.61）。
 *
 * 节奏由设置里的「更新检查周期」决定（0 = 不自动检查）。每次醒来做三件事：
 * 查 GitHub 最新正式版 → 有新版本就记下来并提示 → 允许自动安装的就把包下好、写回扩展目录。
 *
 * 全部走可选外部服务网关，所以「允许外部辅助服务」没开时这里一步都不会走。
 */
import { checkRelease, downloadArchive, newerRelease, pickArchive, type ReleaseInfo } from '../shared/releases';
import { loadSettings } from '../shared/settings';
import { installPackage, isExtensionFolder } from '../shared/installer';
import {
  clearUpdateState, directoryPermission, keepOnlyPackage, readDirectory, readPackage, readUpdateState, savePackage, writeUpdateState,
} from '../shared/update-store';

const ALARM = 'margin:update-check';
/** 定时任务名字，后台与设置面板都要用到 */
export const UPDATE_ALARM = ALARM;

/** Chrome 117 之前的 alarms 是回调风格，这里统一成 Promise */
interface AlarmApi {
  get(name: string, cb: (alarm: chrome.alarms.Alarm | undefined) => void): void;
  create(name: string, info: chrome.alarms.AlarmCreateInfo): void;
  clear(name: string, cb: (done: boolean) => void): void;
}
/** 延到调用时再取 chrome.alarms：模块顶层不碰浏览器 API，方便在测试里替换 */
const alarmApi = () => chrome.alarms as unknown as AlarmApi;
const getAlarm = (name: string) => new Promise<chrome.alarms.Alarm | undefined>(resolve => alarmApi().get(name, resolve));
const clearAlarm = (name: string) => new Promise<boolean>(resolve => alarmApi().clear(name, resolve));

/** 商店版由浏览器自己更新，不用我们管 */
function storeManaged(): boolean {
  return Boolean((chrome.runtime.getManifest() as chrome.runtime.Manifest & { update_url?: string }).update_url);
}

/** 按当前设置重建定时任务；周期为 0 时把任务撤掉 */
export async function syncSchedule(): Promise<void> {
  const settings = await loadSettings();
  const hours = settings.updateInterval;
  const existing = await getAlarm(ALARM);
  if (!hours) {
    if (existing) await clearAlarm(ALARM);
    return;
  }
  const period = hours * 60;
  if (existing && Math.abs((existing.periodInMinutes ?? 0) - period) < 0.01) return;
  await clearAlarm(ALARM);
  alarmApi().create(ALARM, { periodInMinutes: period });
}

/** 提示用户有新版本：图标角标 */
async function markBadge(): Promise<void> {
  try {
    await chrome.action.setBadgeText({ text: '新' });
    await chrome.action.setBadgeBackgroundColor({ color: '#00aeec' });
  } catch { /* 角标只是提示，失败不影响更新本身。 */ }
}

async function clearBadge(): Promise<void> {
  try { await chrome.action.setBadgeText({ text: '' }); } catch { /* 同上。 */ }
}

/** 下载并暂存发布包 */
async function stagePackage(info: ReleaseInfo): Promise<void> {
  const asset = pickArchive(info);
  if (!asset) throw new Error('这个版本没有附可安装的发布包');
  const zip = await downloadArchive(asset);
  await savePackage(info.tag, zip);
  await keepOnlyPackage(info.tag);
  await writeUpdateState({ tag: info.tag, name: info.name, url: info.url, at: Date.now(), ready: true });
}

/**
 * 目录已经授权过时可以直接写盘并重载扩展，整个过程不用用户再动手。
 * 没授权就只把包准备好，等用户在更新页里点一次「选择扩展目录」。
 */
async function installIfAuthorized(tag: string): Promise<boolean> {
  const dir = await readDirectory();
  if (!dir) return false;
  if (await directoryPermission(dir) !== 'granted') return false;
  if (!await isExtensionFolder(dir)) return false;
  const zip = await readPackage(tag);
  if (!zip) return false;
  await installPackage(dir, zip, tag);
  return true;
}

/** 一次完整的检查：发现新版本 → 记录 → 下载 → 能写就写 */
export async function runCheck(options: { quiet?: boolean } = {}): Promise<void> {
  const settings = await loadSettings();
  if (!settings.enabled || !settings.privacyExternal || storeManaged()) return;
  let info: ReleaseInfo;
  try { info = await checkRelease(true); } catch { return; }
  const current = chrome.runtime.getManifest().version;
  if (!newerRelease(info.tag, current)) {
    if (!options.quiet) await clearBadge();
    return;
  }
  const known = await readUpdateState();
  if (!known || known.tag !== info.tag) {
    await writeUpdateState({ tag: info.tag, name: info.name, url: info.url, at: Date.now() });
    await markBadge();
  }
  if (!settings.autoUpdate) return;
  const state = await readUpdateState();
  if (!state?.ready) {
    try { await stagePackage(info); } catch { return; }
  }
  try {
    if (await installIfAuthorized(info.tag)) {
      await clearUpdateState();
      await clearBadge();
      chrome.runtime.reload();
    }
  } catch { /* 写盘失败时保留已下载的包，等用户手动重试。 */ }
}

/** 后台启动时对一遍账：版本已经追上就清掉提示 */
export async function initScheduler(): Promise<void> {
  await syncSchedule();
  const state = await readUpdateState();
  const current = chrome.runtime.getManifest().version;
  if (state && !newerRelease(state.tag, current)) {
    await clearUpdateState();
    await clearBadge();
  }
}
