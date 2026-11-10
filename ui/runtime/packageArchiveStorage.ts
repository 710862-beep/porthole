import type { StoredPackageArchive } from "./types";

export const STORE_PACKAGE_DIRECTORY = "PortholePackages";
const MAX_PACKAGE_ARCHIVE_BYTES = 256 * 1024 * 1024;

interface IterablePackageDirectoryHandle extends FileSystemDirectoryHandle {
  entries(): AsyncIterableIterator<[string, FileSystemFileHandle | FileSystemDirectoryHandle]>;
}

async function validatedName(file: File): Promise<string> {
  if (!file.name.toLowerCase().endsWith(".nupkg")) {
    throw new Error("Only .nupkg package archives may be saved in the Store download area.");
  }
  if (file.size < 4 || file.size > MAX_PACKAGE_ARCHIVE_BYTES) {
    throw new Error(`Package archive must be between 4 bytes and ${Math.round(MAX_PACKAGE_ARCHIVE_BYTES / 1024 / 1024)} MB.`);
  }
  const signature = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  if (signature[0] !== 0x50 || signature[1] !== 0x4b || ![0x03, 0x05, 0x07].includes(signature[2] ?? -1)) {
    throw new Error("The selected file is not a ZIP-formatted .nupkg archive.");
  }
  const name = file.name
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_")
    .replace(/^\.+$/, "_")
    .trim()
    .slice(0, 180);
  if (!name || !name.toLowerCase().endsWith(".nupkg")) {
    throw new Error("The package archive has no safe filename.");
  }
  return name;
}

async function writeDirectoryArchive(
  root: FileSystemDirectoryHandle,
  file: File,
): Promise<StoredPackageArchive> {
  const name = await validatedName(file);
  const directory = await root.getDirectoryHandle(STORE_PACKAGE_DIRECTORY, { create: true });
  const handle = await directory.getFileHandle(name, { create: true });
  const writable = await handle.createWritable({ keepExistingData: false });
  try {
    await writable.write(await file.arrayBuffer());
    await writable.close();
  } catch (error) {
    try {
      await writable.abort();
    } catch {
      // Preserve the write failure; an aborted stream may already be closed.
    }
    throw error;
  }
  const saved = await handle.getFile();
  return {
    name,
    path: `${STORE_PACKAGE_DIRECTORY}/${name}`,
    sizeBytes: saved.size,
    lastModified: saved.lastModified,
  };
}

function safeStoredArchiveName(name: string): string {
  if (
    !name ||
    name !== name.trim() ||
    name.includes("/") ||
    name.includes("\\") ||
    /[\u0000-\u001f<>:"|?*]/.test(name) ||
    name === "." ||
    name === ".." ||
    !name.toLowerCase().endsWith(".nupkg")
  ) {
    throw new Error("The stored package archive name is invalid.");
  }
  return name;
}

async function readDirectoryArchive(root: FileSystemDirectoryHandle, name: string): Promise<File | null> {
  const safeName = safeStoredArchiveName(name);
  let directory: FileSystemDirectoryHandle;
  try {
    directory = await root.getDirectoryHandle(STORE_PACKAGE_DIRECTORY);
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") return null;
    throw error;
  }
  let file: File;
  try {
    const handle = await directory.getFileHandle(safeName);
    file = await handle.getFile();
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") return null;
    throw error;
  }
  if (file.size < 4 || file.size > MAX_PACKAGE_ARCHIVE_BYTES) {
    throw new Error("The stored package archive no longer meets the Store size limit.");
  }
  const signature = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  if (signature[0] !== 0x50 || signature[1] !== 0x4b || ![0x03, 0x05, 0x07].includes(signature[2] ?? -1)) {
    throw new Error("The stored package archive is not a ZIP-formatted .nupkg file.");
  }
  return file;
}

async function listDirectoryArchives(root: FileSystemDirectoryHandle): Promise<StoredPackageArchive[]> {
  let directory: FileSystemDirectoryHandle;
  try {
    directory = await root.getDirectoryHandle(STORE_PACKAGE_DIRECTORY);
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") return [];
    throw error;
  }

  const archives: StoredPackageArchive[] = [];
  for await (const [name, handle] of (directory as IterablePackageDirectoryHandle).entries()) {
    if (handle.kind !== "file" || !name.toLowerCase().endsWith(".nupkg")) continue;
    const file = await handle.getFile();
    archives.push({
      name,
      path: `${STORE_PACKAGE_DIRECTORY}/${name}`,
      sizeBytes: file.size,
      lastModified: file.lastModified,
    });
  }
  return archives.sort((a, b) => b.lastModified - a.lastModified);
}

/** Storage for downloads that deliberately remain outside the guest C:\\Game tree. */
export class PackageArchiveStorage {
  private readonly memory = new Map<string, { archive: StoredPackageArchive; bytes: Uint8Array }>();

  async storeInDirectory(root: FileSystemDirectoryHandle, file: File): Promise<StoredPackageArchive> {
    return writeDirectoryArchive(root, file);
  }

  listInDirectory(root: FileSystemDirectoryHandle): Promise<StoredPackageArchive[]> {
    return listDirectoryArchives(root);
  }

  readInDirectory(root: FileSystemDirectoryHandle, name: string): Promise<File | null> {
    return readDirectoryArchive(root, name);
  }

  async storeInMemory(file: File): Promise<StoredPackageArchive> {
    const name = await validatedName(file);
    const key = name.toLowerCase();
    const previous = this.memory.get(key);
    const total = [...this.memory.values()].reduce((sum, item) => sum + item.bytes.byteLength, 0);
    if (total - (previous?.bytes.byteLength ?? 0) + file.size > MAX_PACKAGE_ARCHIVE_BYTES) {
      throw new Error(`In-memory package storage is limited to ${Math.round(MAX_PACKAGE_ARCHIVE_BYTES / 1024 / 1024)} MB.`);
    }
    const lastModified = Date.now();
    const archive: StoredPackageArchive = {
      name,
      path: `${STORE_PACKAGE_DIRECTORY}/${name}`,
      sizeBytes: file.size,
      lastModified,
    };
    this.memory.set(key, { archive, bytes: new Uint8Array(await file.arrayBuffer()) });
    return { ...archive };
  }

  listInMemory(): StoredPackageArchive[] {
    return [...this.memory.values()]
      .map(({ archive }) => ({ ...archive }))
      .sort((a, b) => b.lastModified - a.lastModified);
  }

  readInMemory(name: string): File | null {
    const safeName = safeStoredArchiveName(name);
    const stored = this.memory.get(safeName.toLowerCase());
    if (!stored) return null;
    const copy = new ArrayBuffer(stored.bytes.byteLength);
    new Uint8Array(copy).set(stored.bytes);
    return new File([copy], stored.archive.name, {
      type: "application/octet-stream",
      lastModified: stored.archive.lastModified,
    });
  }
}
