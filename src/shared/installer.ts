/**
 * 把下载好的发布包写回扩展目录（v0.61 自动更新）。
 *
 * 只往用户亲手授权的目录里写：扩展无法自行改动安装位置，必须由用户在更新页里
 * 选一次（或授权过一次后复用），这是浏览器沙箱之外的唯一可行路径。
 */
import { readManifestVersion, unzip, type ZipFile } from './zip';

/** 目标目录里得是映间才会写，防止用户选错文件夹把别的东西冲掉 */
export async function isExtensionFolder(dir: FileSystemDirectoryHandle): Promise<boolean> {
  try {
    const handle = await dir.getFileHandle('manifest.json');
    const parsed = JSON.parse(await (await handle.getFile()).text()) as { name?: unknown; short_name?: unknown };
    const name = typeof parsed.name === 'string' ? parsed.name : '';
    return parsed.short_name === 'MARGIN' || name === 'MARGIN' || name.includes('MARGIN');
  } catch { return false; }
}

/**
 * 写文件。manifest.json 放到最后写：中途失败时目录里还是旧版清单，扩展不会半新半旧。
 */
export async function writeFiles(dir: FileSystemDirectoryHandle, files: ZipFile[]): Promise<number> {
  const ordered = [...files].sort((a, b) => (a.path === 'manifest.json' ? 1 : 0) - (b.path === 'manifest.json' ? 1 : 0));
  let count = 0;
  for (const file of ordered) {
    const parts = file.path.split('/');
    const name = parts.pop();
    if (!name) continue;
    let target = dir;
    for (const part of parts) target = await target.getDirectoryHandle(part, { create: true });
    const handle = await target.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    try {
      await writable.write(file.data as unknown as BufferSource);
    } finally {
      await writable.close();
    }
    count++;
  }
  return count;
}

/**
 * 解包并写入。返回实际写入的文件数和包里的版本号。
 * 版本对不上就直接失败，不往目录里写半个版本。
 */
export async function installPackage(dir: FileSystemDirectoryHandle, zip: ArrayBuffer, expectTag: string): Promise<{ files: number; version: string }> {
  const files = await unzip(zip);
  const version = readManifestVersion(files);
  if (!version) throw new Error('更新包里没有 manifest.json');
  if (version !== expectTag) throw new Error(`更新包版本对不上（包内 ${version}，期望 ${expectTag}）`);
  const count = await writeFiles(dir, files);
  return { files: count, version };
}
