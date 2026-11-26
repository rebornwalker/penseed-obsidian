/**
 * volumeMapping.ts — folder → volume inference (Phase 7.0).
 *
 * A project's top-level folder maps to a project; first-level subfolders within
 * that folder map to volumes (Book 1, Book 2, ...). Files sitting directly in the
 * project folder are "unassigned" (no volume). Volume numbers are assigned by the
 * order the subfolders first appear across the chapter files, 1..N.
 *
 * Language-independent on purpose: it keys purely off folder structure, never off
 * words like "Book"/"Volume"/"卷", so it works for any author (memory
 * `language_agnostic_algorithms`).
 */

// Relative path of `filePath` inside `projectFolder`, or null when outside it.
function relativeTo(filePath: string, projectFolder: string): string | null {
  const prefix =
    projectFolder === "" ? "" : projectFolder.replace(/\/+$/, "") + "/";
  if (projectFolder !== "" && !filePath.startsWith(prefix)) return null;
  return filePath.slice(prefix.length);
}

// First-level subfolder name for a file inside the project folder, or null when the
// file sits directly at the project root (unassigned).
export function inferVolumeFolder(
  projectFolder: string,
  filePath: string
): string | null {
  const rel = relativeTo(filePath, projectFolder);
  if (rel === null) return null;
  const segments = rel.split("/");
  return segments.length > 1 ? segments[0] : null;
}

// Build folder → volumeNumber map (1..N) by first-appearance order across `paths`.
export function buildVolumeNumberMap(
  projectFolder: string,
  paths: string[]
): Map<string, number> {
  const map = new Map<string, number>();
  let next = 1;
  for (const p of paths) {
    const folder = inferVolumeFolder(projectFolder, p);
    if (folder !== null && !map.has(folder)) {
      map.set(folder, next++);
    }
  }
  return map;
}

export interface FileVolumeInfo {
  volumeFolder: string | null;
  volumeNumber: number | null;
}

// Full volume info for a single file.
export function inferFileVolume(
  projectFolder: string,
  filePath: string,
  volumeNumberMap: Map<string, number>
): FileVolumeInfo {
  const volumeFolder = inferVolumeFolder(projectFolder, filePath);
  const volumeNumber =
    volumeFolder !== null ? volumeNumberMap.get(volumeFolder) ?? null : null;
  return { volumeFolder, volumeNumber };
}
