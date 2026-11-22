import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  checkRelease: vi.fn(),
  downloadArchive: vi.fn(),
  pickArchive: vi.fn(() => ({ name: 'margin.zip', url: 'https://github.com/jiuyang5354/bilibili-margin/releases/download/v0.60.89/margin.zip', size: 1 })),
  readUpdateState: vi.fn(async (): Promise<{ tag: string; url: string; at: number } | null> => null),
  writeUpdateState: vi.fn(async () => {}),
  clearUpdateState: vi.fn(async () => {}),
  savePackage: vi.fn(async () => {}),
  keepOnlyPackage: vi.fn(async () => {}),
  readPackage: vi.fn(async () => null),
  readDirectory: vi.fn(async () => null),
  directoryPermission: vi.fn(async () => 'prompt'),
  installPackage: vi.fn(async () => ({ files: 3, version: '0.60.89' })),
}));

vi.mock('../../src/shared/releases', () => ({
  checkRelease: mocks.checkRelease,
  downloadArchive: mocks.downloadArchive,
  pickArchive: mocks.pickArchive,
  newerRelease: (tag: string, current: string) => tag !== current,
}));
vi.mock('../../src/shared/update-store', () => ({
  clearUpdateState: mocks.clearUpdateState,
  directoryPermission: mocks.directoryPermission,
  keepOnlyPackage: mocks.keepOnlyPackage,
  readDirectory: mocks.readDirectory,
  readPackage: mocks.readPackage,
  readUpdateState: mocks.readUpdateState,
  savePackage: mocks.savePackage,
  writeUpdateState: mocks.writeUpdateState,
}));
vi.mock('../../src/shared/installer', () => ({
  installPackage: mocks.installPackage,
  isExtensionFolder: vi.fn(async () => true),
}));

import { runCheck, syncSchedule } from '../../src/background/update-scheduler';

const settings: Record<string, unknown> = {};
const alarms = { create: vi.fn(), clear: vi.fn(), get: vi.fn() };
let existing: chrome.alarms.Alarm | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of Object.keys(settings)) delete settings[key];
  existing = undefined;
  alarms.get.mockImplementation((_name: string, cb: (alarm?: chrome.alarms.Alarm) => void) => cb(existing));
  alarms.clear.mockImplementation((_name: string, cb: (done: boolean) => void) => cb(true));
  (globalThis as Record<string, unknown>).chrome = {
    storage: {
      local: {
        get: async (key: string) => (key in settings ? { [key]: settings[key] } : {}),
        set: async (obj: Record<string, unknown>) => { Object.assign(settings, obj); },
      },
      onChanged: { addListener: () => {} },
    },
    alarms: { ...alarms, onAlarm: { addListener: () => {} } },
    runtime: { getManifest: () => ({ version: '0.60.88' }) },
    action: { setBadgeText: vi.fn(async () => {}), setBadgeBackgroundColor: vi.fn(async () => {}) },
  };
  mocks.readUpdateState.mockResolvedValue(null);
  mocks.readDirectory.mockResolvedValue(null);
  mocks.readPackage.mockResolvedValue(null);
  mocks.pickArchive.mockReturnValue({ name: 'margin.zip', url: 'https://github.com/jiuyang5354/bilibili-margin/releases/download/v0.60.89/margin.zip', size: 1 });
});

describe('更新定时任务', () => {
  it('周期为关闭时不排任务，已有的任务会被撤掉', async () => {
    existing = { name: 'margin:update-check', periodInMinutes: 360 } as chrome.alarms.Alarm;
    await syncSchedule();
    expect(alarms.clear).toHaveBeenCalled();
    expect(alarms.create).not.toHaveBeenCalled();
  });

  it('按设置排任务，小时换算成分钟', async () => {
    settings['margin:settings'] = { updateInterval: 6 };
    await syncSchedule();
    expect(alarms.create).toHaveBeenCalledWith('margin:update-check', { periodInMinutes: 360 });
  });

  it('周期没变就不重复排', async () => {
    existing = { name: 'margin:update-check', periodInMinutes: 360 } as chrome.alarms.Alarm;
    settings['margin:settings'] = { updateInterval: 6 };
    await syncSchedule();
    expect(alarms.create).not.toHaveBeenCalled();
  });

  it('外部服务没开时不查版本', async () => {
    settings['margin:settings'] = { updateInterval: 6, privacyExternal: false };
    await runCheck();
    expect(mocks.checkRelease).not.toHaveBeenCalled();
  });

  it('发现新版本就记下来并打角标', async () => {
    settings['margin:settings'] = { updateInterval: 6, privacyExternal: true };
    mocks.checkRelease.mockResolvedValue({ tag: '0.60.89', name: 'v0.6.89', url: 'https://github.com/jiuyang5354/bilibili-margin/releases/tag/v0.60.89' });
    await runCheck();
    expect(mocks.writeUpdateState).toHaveBeenCalledWith(expect.objectContaining({ tag: '0.60.89' }));
  });

  it('开了自动安装就把发布包下载到本机', async () => {
    settings['margin:settings'] = { updateInterval: 6, privacyExternal: true, autoUpdate: true };
    mocks.checkRelease.mockResolvedValue({ tag: '0.60.89', name: 'v0.6.89', url: 'https://github.com/jiuyang5354/bilibili-margin/releases/tag/v0.60.89' });
    mocks.downloadArchive.mockResolvedValue(new ArrayBuffer(8));
    await runCheck();
    expect(mocks.downloadArchive).toHaveBeenCalled();
    expect(mocks.savePackage).toHaveBeenCalledWith('0.60.89', expect.anything());
  });

  it('没有授权目录时不会自己写盘', async () => {
    settings['margin:settings'] = { updateInterval: 6, privacyExternal: true, autoUpdate: true };
    mocks.checkRelease.mockResolvedValue({ tag: '0.60.89', name: 'v0.6.89', url: 'https://github.com/jiuyang5354/bilibili-margin/releases/tag/v0.60.89' });
    mocks.downloadArchive.mockResolvedValue(new ArrayBuffer(8));
    await runCheck();
    expect(mocks.installPackage).not.toHaveBeenCalled();
  });
});
