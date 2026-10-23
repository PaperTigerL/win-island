import { existsSync, renameSync, rmSync, statSync } from 'node:fs';

export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

export function rotateIfNeeded(file, maxBytes = DEFAULT_MAX_BYTES) {
  try {
    if (!existsSync(file)) return null;
    const bytes = statSync(file).size;
    if (bytes <= maxBytes) return null;
    const to = `${file}.1`;
    if (existsSync(to)) rmSync(to, { force: true });
    renameSync(file, to);
    return { file, bytes, to };
  } catch {
    return null;
  }
}
