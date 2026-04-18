// Shared atomic-write helper. Dumps to a sibling `.tmp` then renames;
// cleans up the `.tmp` if rename fails so a later `git add` never
// stages a partial temp file.
//
// Same-filesystem rename is atomic on POSIX, so a crash mid-write never
// leaves a partial committed file.

import { existsSync, renameSync, unlinkSync, writeFileSync } from "node:fs";

/**
 * Atomically write `contents` to `dest`. Writes to a sibling `.tmp`, then
 * renames (atomic on same-FS POSIX). Cleans up the `.tmp` if the rename
 * fails so no partial file is left for a later `git add` to stage.
 */
export function writeFileAtomic(dest: string, contents: string): void {
  const tmp = `${dest}.tmp`;
  try {
    writeFileSync(tmp, contents);
    renameSync(tmp, dest);
  } catch (err) {
    if (existsSync(tmp)) {
      try {
        unlinkSync(tmp);
      } catch {
        // swallow — already on the error path
      }
    }
    throw err;
  }
}
