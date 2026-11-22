import { optionalFetch } from './privacy';

export interface ReleaseAsset { name: string; url: string; size: number }
export interface ReleaseInfo { at: number; tag: string; name?: string; url: string; assets?: ReleaseAsset[] }
const KEY = 'margin:update-check';
function valid(value: unknown): value is ReleaseInfo {
  if (!value || typeof value !== 'object') return false;
  const r = value as ReleaseInfo;
  return Number.isFinite(r.at) && typeof r.tag === 'string' && typeof r.url === 'string' && /^\d+(?:\.\d+){1,3}$/.test(r.tag) &&
    /^https:\/\/github\.com\/jiuyang5354\/bilibili-margin\/releases\/tag\/v?\d+(?:\.\d+){1,3}$/.test(r.url);
}
/** 只有本仓库发布的两个扩展包可以下载，且地址必须落在 releases/download 下面 */
const ARCHIVES = { chrome: 'margin.zip', firefox: 'margin-firefox.zip' } as const;
const ASSET_URL = /^https:\/\/github\.com\/jiuyang5354\/bilibili-margin\/releases\/download\/v\d+(?:\.\d+){1,3}\/margin(?:-firefox)?\.zip$/;
export function newerRelease(tag: string, current: string): boolean {
  const a = tag.split('.').map(Number), b = current.split('.').map(Number);
  for (let i = 0; i < 4; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  return false;
}
/** 弹窗自动检查复用六小时缓存；设置中的明确检查绕过缓存，仍遵守外部服务选择。 */
export async function checkRelease(force = false): Promise<ReleaseInfo> {
  const cached: unknown = (await chrome.storage.local.get(KEY))[KEY];
  if (!force && valid(cached) && Date.now() >= cached.at && Date.now() - cached.at < 6 * 3600e3) return cached;
  try {
    return await checkViaApi();
  } catch (apiError) {
    // GitHub API 不登录时每个 IP 只有 60 次/小时，代理出口很容易撞上限（403）。
    // 这时改走发布页：它会跳到最新正式版的 tag 页，从跳转地址就能拿到版本号，不占 API 配额。
    try {
      return await checkViaReleasePage();
    } catch (fallbackError) {
      console.warn('[MARGIN] 发布页通道也没能取到版本', fallbackError);
      throw apiError;
    }
  }
}

/** 走 GitHub API：能拿到发布标题和附件列表 */
async function checkViaApi(): Promise<ReleaseInfo> {
  const response = await optionalFetch('update', 'https://api.github.com/repos/jiuyang5354/bilibili-margin/releases/latest', { headers: { Accept: 'application/vnd.github+json' } });
  if (!response.ok) throw new Error(`更新查询失败（HTTP ${response.status}）`);
  const data = await response.json();
  const info: ReleaseInfo = { at: Date.now(), tag: String(data.tag_name || '').replace(/^v/, ''), name: typeof data.name === 'string' ? data.name : undefined, url: data.html_url };
  if (!valid(info) || data.draft || data.prerelease) throw new Error('正式版信息暂不可用');
  info.assets = readAssets(data.assets);
  await chrome.storage.local.set({ [KEY]: info });
  return info;
}

/** 走发布页跳转：不需要 API，版本号从最终地址里取 */
async function checkViaReleasePage(): Promise<ReleaseInfo> {
  const response = await optionalFetch('release-page', 'https://github.com/jiuyang5354/bilibili-margin/releases/latest');
  if (!response.ok) throw new Error(`更新查询失败（HTTP ${response.status}）`);
  let pathname = '';
  try { pathname = new URL(response.url).pathname; } catch { pathname = ''; }
  const match = /\/releases\/tag\/v(\d+(?:\.\d+){1,3})$/.exec(pathname);
  if (!match) throw new Error('正式版信息暂不可用');
  const tag = match[1];
  const info: ReleaseInfo = { at: Date.now(), tag, name: `v${tag}`, url: `https://github.com/jiuyang5354/bilibili-margin/releases/tag/v${tag}` };
  await chrome.storage.local.set({ [KEY]: info });
  return info;
}

/** 只留下名字和地址都合规的发布包，其余一律丢掉 */
function readAssets(raw: unknown): ReleaseAsset[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap(item => {
    if (!item || typeof item !== 'object') return [];
    const a = item as { name?: unknown; browser_download_url?: unknown; size?: unknown };
    if (typeof a.name !== 'string' || typeof a.browser_download_url !== 'string') return [];
    if (!ASSET_URL.test(a.browser_download_url)) return [];
    return [{ name: a.name, url: a.browser_download_url, size: typeof a.size === 'number' && Number.isFinite(a.size) ? a.size : 0 }];
  });
}

/** Firefox 装的是单独的包，其余平台用 Chrome 包 */
export function isFirefox(): boolean {
  try { return new URL(chrome.runtime.getURL('')).protocol === 'moz-extension:'; } catch { return false; }
}

/** 取当前平台对应的发布包；没有附件列表时按 GitHub 的固定命名拼下载地址 */
export function pickArchive(info: ReleaseInfo): ReleaseAsset | null {
  const want = isFirefox() ? ARCHIVES.firefox : ARCHIVES.chrome;
  const asset = info.assets?.find(a => a.name === want);
  if (asset && ASSET_URL.test(asset.url)) return asset;
  const url = `https://github.com/jiuyang5354/bilibili-margin/releases/download/v${info.tag}/${want}`;
  return ASSET_URL.test(url) ? { name: want, url, size: 0 } : null;
}

/** 下载发布包；走可选外部服务网关，同样受「允许外部辅助服务」开关约束 */
export async function downloadArchive(asset: ReleaseAsset): Promise<ArrayBuffer> {
  const response = await optionalFetch('update-asset', asset.url);
  if (!response.ok) {
    if (response.status === 404) throw new Error('这个版本没有附发布包，请到发布页手动下载');
    throw new Error(`更新包下载失败（HTTP ${response.status}）`);
  }
  return response.arrayBuffer();
}
