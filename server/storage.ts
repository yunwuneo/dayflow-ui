import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

export class ScreenshotStorageError extends Error {
  readonly statusCode = 503;
  constructor(cause: unknown) {
    const code = (cause as NodeJS.ErrnoException)?.code;
    const message = code === 'EACCES' || code === 'EPERM'
      ? `截图存储目录不可写，请检查 STORAGE_DIR 的目录属主和写入权限（${code}）`
      : code === 'EROFS' ? '截图存储目录为只读，请检查挂载配置（EROFS）'
      : code === 'ENOSPC' || code === 'EDQUOT' ? `截图存储空间或配额不足（${code}）`
      : '截图存储失败，请检查后端日志和 STORAGE_DIR 配置';
    super(message, { cause });
    this.name = 'ScreenshotStorageError';
  }
}

export async function prepareScreenshotStorage(directory: string) {
  const probe = path.join(directory, `.write-check-${randomBytes(8).toString('hex')}`);
  try {
    await mkdir(directory, { recursive: true });
    // mkdir succeeds for an existing directory even when the app cannot write to it.
    await writeFile(probe, '', { flag: 'wx', mode: 0o600 });
    await unlink(probe);
  } catch (error) {
    throw new ScreenshotStorageError(error);
  } finally {
    await unlink(probe).catch(() => {});
  }
}

export async function storeScreenshot(directory: string, hash: string, image: Buffer) {
  const target = path.join(directory, `${hash}.jpg`);
  if (existsSync(target)) return;
  const temporary = `${target}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, image, { flag: 'wx', mode: 0o600 });
    await rename(temporary, target);
  } catch (error) {
    throw new ScreenshotStorageError(error);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}
