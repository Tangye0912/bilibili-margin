/**
 * 自动更新的本地状态（v0.61）。
 *
 * 三样东西存在本机：
 * 1. chrome.storage.local 里的状态（发现的新版本、下载进度）；
 * 2. IndexedDB 里已下载的发布包（zip 字节，解包后写进扩展目录）；
 * 3. IndexedDB 里用户授权过的扩展目录句柄（下次可以直接写，不用再选）。
 *
 * 都不上传任何数据。
 */

export const UPDATE_STATE_KEY = 'margin:update-state';

export interface UpdateState {
  /** 发现的新版本号，例如 0.60.89 */
  tag: string;
  /** 发布标题 */
  name?: string;
  /** release 页面地址 */
  url: string;
  /** 发现时间 */
  at: number;
  /** 包已经下载并解包，可以直接写入 */
  ready?: boolean;
  /** 上次失败的原因 */
  error?: string;
}

const DB_NAME = 'margin-update';
const DB_VERSION = 1;
const PACKAGES = 'packages';
const HANDLES = 'handles';
const DIR_KEY = 'extension-dir';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(PACKAGES)) db.createObjectStore(PACKAGES);
      if (!db.objectStoreNames.contains(HANDLES)) db.createObjectStore(HANDLES);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('无法打开本地存储'));
  });
}

function tx<T>(store: string, mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(db => new Promise<T>((resolve, reject) => {
    const transaction = db.transaction(store, mode);
    const request = run(transaction.objectStore(store));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('本地存储操作失败'));
    transaction.oncomplete = () => db.close();
  }));
}

/* ---------- 更新状态 ---------- */

export async function readUpdateState(): Promise<UpdateState | null> {
  const raw = (await chrome.storage.local.get(UPDATE_STATE_KEY))[UPDATE_STATE_KEY];
  if (!raw || typeof raw !== 'object') return null;
  const state = raw as UpdateState;
  return typeof state.tag === 'string' && /^\d+(?:\.\d+){1,3}$/.test(state.tag) && typeof state.url === 'string' ? state : null;
}

export async function writeUpdateState(state: UpdateState): Promise<void> {
  await chrome.storage.local.set({ [UPDATE_STATE_KEY]: state });
}

export async function clearUpdateState(): Promise<void> {
  await chrome.storage.local.remove(UPDATE_STATE_KEY);
}

/* ---------- 发布包 ---------- */

/** 存下下载好的 zip；同一版本重复下载直接覆盖 */
export async function savePackage(tag: string, zip: ArrayBuffer): Promise<void> {
  await tx(PACKAGES, 'readwrite', store => store.put(zip, tag));
}

export async function readPackage(tag: string): Promise<ArrayBuffer | null> {
  const value = await tx<ArrayBuffer | undefined>(PACKAGES, 'readonly', store => store.get(tag));
  return value ?? null;
}

/** 只保留最新的那个包，避免旧包一直占着空间 */
export async function keepOnlyPackage(tag: string): Promise<void> {
  await openDb().then(db => new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(PACKAGES, 'readwrite');
    const store = transaction.objectStore(PACKAGES);
    const request = store.getAllKeys();
    request.onsuccess = () => {
      for (const key of request.result) if (key !== tag) store.delete(key);
    };
    transaction.oncomplete = () => { db.close(); resolve(); };
    transaction.onerror = () => { db.close(); reject(transaction.error ?? new Error('本地存储操作失败')); };
  }));
}

/* ---------- 扩展目录授权 ---------- */

/** 记住用户授权过的扩展目录，下次更新可以直接写 */
export async function saveDirectory(handle: FileSystemDirectoryHandle): Promise<void> {
  await tx(HANDLES, 'readwrite', store => store.put(handle, DIR_KEY));
}

export async function readDirectory(): Promise<FileSystemDirectoryHandle | null> {
  const handle = await tx<FileSystemDirectoryHandle | undefined>(HANDLES, 'readonly', store => store.get(DIR_KEY));
  return handle ?? null;
}

export async function clearDirectory(): Promise<void> {
  await tx(HANDLES, 'readwrite', store => store.delete(DIR_KEY));
}

/** 目录授权还在吗：已授权返回 granted，失效返回 prompt */
export async function directoryPermission(handle: FileSystemDirectoryHandle): Promise<PermissionState> {
  const ask = handle as FileSystemDirectoryHandle & {
    queryPermission?: (options?: { mode?: string }) => Promise<PermissionState>;
  };
  if (typeof ask.queryPermission !== 'function') return 'prompt';
  try {
    return await ask.queryPermission({ mode: 'readwrite' });
  } catch { return 'denied'; }
}

/** 重新申请目录权限：必须在用户手势里调用 */
export async function requestDirectoryPermission(handle: FileSystemDirectoryHandle): Promise<PermissionState> {
  const ask = handle as FileSystemDirectoryHandle & {
    requestPermission?: (options?: { mode?: string }) => Promise<PermissionState>;
  };
  if (typeof ask.requestPermission !== 'function') return 'prompt';
  try {
    return await ask.requestPermission({ mode: 'readwrite' });
  } catch { return 'denied'; }
}
