import { unzipSync } from "fflate";

const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 128 * 1024 * 1024;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_ENTRY_COUNT = 4096;
const MAX_EXECUTABLES = 32;
const MAX_SUPPORT_FILES = 256;
const ZIP_EOCD = 0x06054b50;
const ZIP_CENTRAL_FILE = 0x02014b50;
const ZIP_LOCAL_FILE = 0x04034b50;

export interface PackagePayloadFile {
  /** Safe archive-relative path. The importer preserves this beneath C:\\Game. */
  path: string;
  name: string;
  bytes: Uint8Array;
}

export interface EmbeddedGuestExecutable {
  /** Path inside the .nupkg, shown for review before any code is run. */
  archivePath: string;
  name: string;
  sizeBytes: number;
  /** The executable and safe same-folder data files to copy into the guest. */
  payload: PackagePayloadFile[];
}

export interface ChocolateyArchiveInspection {
  executables: EmbeddedGuestExecutable[];
  unsupportedExecutables: string[];
  skippedScripts: number;
}

interface ZipEntry {
  path: string;
  compressedBytes: number;
  expandedBytes: number;
  localOffset: number;
  method: number;
  isDirectory: boolean;
}

function safeArchivePath(raw: string): string {
  const path = raw.replaceAll("\\", "/");
  if (
    !path ||
    path.includes("\0") ||
    path.startsWith("/") ||
    /^[a-z]:/i.test(path) ||
    path.split("/").some((part) => part === ".." || part === ".")
  ) {
    throw new Error(`Unsafe path in package archive: ${raw.slice(0, 180)}`);
  }
  const parts = path.split("/");
  if (parts.some((part) => /[\u0000-\u001f<>:"|?*]/.test(part))) {
    throw new Error(`Unsupported filename in package archive: ${raw.slice(0, 180)}`);
  }
  return parts.join("/");
}

function decodeName(bytes: Uint8Array, utf8: boolean): string {
  if (!utf8 && bytes.some((byte) => byte > 0x7f)) {
    throw new Error("Package archive contains a non-UTF-8 filename; refusing ambiguous paths.");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Package archive contains an invalid UTF-8 filename.");
  }
}

function inspectZipDirectory(bytes: Uint8Array): ZipEntry[] {
  if (bytes.byteLength < 22) throw new Error("Package archive is too short to be a ZIP file.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const searchStart = Math.max(0, bytes.byteLength - 22 - 0xffff);
  let eocd = -1;
  for (let offset = bytes.byteLength - 22; offset >= searchStart; offset -= 1) {
    if (view.getUint32(offset, true) === ZIP_EOCD) {
      const commentLength = view.getUint16(offset + 20, true);
      if (offset + 22 + commentLength === bytes.byteLength) {
        eocd = offset;
        break;
      }
    }
  }
  if (eocd < 0) throw new Error("Package archive has no valid ZIP directory record.");

  const disk = view.getUint16(eocd + 4, true);
  const directoryDisk = view.getUint16(eocd + 6, true);
  const entriesOnDisk = view.getUint16(eocd + 8, true);
  const entryCount = view.getUint16(eocd + 10, true);
  const directoryBytes = view.getUint32(eocd + 12, true);
  const directoryOffset = view.getUint32(eocd + 16, true);
  if (disk !== 0 || directoryDisk !== 0 || entriesOnDisk !== entryCount) {
    throw new Error("Multi-disk ZIP archives are not supported.");
  }
  if (entryCount === 0xffff || directoryBytes === 0xffffffff || directoryOffset === 0xffffffff) {
    throw new Error("ZIP64 package archives are not supported by the bounded installer reader.");
  }
  if (entryCount > MAX_ENTRY_COUNT) {
    throw new Error(`Package archive contains more than ${MAX_ENTRY_COUNT} entries.`);
  }
  const directoryEnd = directoryOffset + directoryBytes;
  if (directoryOffset > eocd || directoryEnd > eocd || directoryEnd < directoryOffset) {
    throw new Error("Package archive directory is outside the archive bounds.");
  }

  const entries: ZipEntry[] = [];
  const seen = new Set<string>();
  let expandedTotal = 0;
  let cursor = directoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > directoryEnd || view.getUint32(cursor, true) !== ZIP_CENTRAL_FILE) {
      throw new Error("Package archive has a malformed central directory.");
    }
    const madeBy = view.getUint16(cursor + 4, true) >>> 8;
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const compressedBytes = view.getUint32(cursor + 20, true);
    const expandedBytes = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const externalAttributes = view.getUint32(cursor + 38, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const recordEnd = cursor + 46 + nameLength + extraLength + commentLength;
    if (recordEnd > directoryEnd || recordEnd < cursor) {
      throw new Error("Package archive has a truncated directory entry.");
    }
    if ((flags & 1) !== 0) throw new Error("Encrypted package entries are not supported.");
    if (method !== 0 && method !== 8) throw new Error(`Unsupported ZIP compression method ${method}.`);

    const rawName = decodeName(
      bytes.subarray(cursor + 46, cursor + 46 + nameLength),
      (flags & 0x0800) !== 0,
    );
    const path = safeArchivePath(rawName);
    const isDirectory = path.endsWith("/");
    const key = path.toLowerCase();
    if (seen.has(key)) throw new Error(`Package archive contains a duplicate path: ${path}`);
    seen.add(key);

    // Reject Unix symbolic links: they can make an otherwise safe relative path escape its root.
    const unixMode = madeBy === 3 ? externalAttributes >>> 16 : 0;
    if ((unixMode & 0xf000) === 0xa000) throw new Error(`Symbolic links are not allowed in package archives: ${path}`);
    if (!isDirectory) {
      if (expandedBytes > MAX_FILE_BYTES) {
        throw new Error(`Package entry exceeds the ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB per-file inspection limit: ${path}`);
      }
      expandedTotal += expandedBytes;
      if (expandedTotal > MAX_EXPANDED_BYTES) {
        throw new Error(`Package expands beyond the ${Math.round(MAX_EXPANDED_BYTES / 1024 / 1024)} MB inspection limit.`);
      }
    }

    if (localOffset + 30 > directoryOffset || view.getUint32(localOffset, true) !== ZIP_LOCAL_FILE) {
      throw new Error(`Package entry has an invalid local record: ${path}`);
    }
    const localFlags = view.getUint16(localOffset + 6, true);
    const localMethod = view.getUint16(localOffset + 8, true);
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    if ((localFlags & 1) !== 0 || localMethod !== method) {
      throw new Error(`Package entry metadata does not match its local record: ${path}`);
    }
    const localNameEnd = localOffset + 30 + localNameLength;
    const dataStart = localNameEnd + localExtraLength;
    const dataEnd = dataStart + compressedBytes;
    if (localNameEnd > directoryOffset || dataEnd > directoryOffset || dataEnd < dataStart) {
      throw new Error(`Package entry data is outside the archive bounds: ${path}`);
    }
    const localName = safeArchivePath(decodeName(
      bytes.subarray(localOffset + 30, localNameEnd),
      (localFlags & 0x0800) !== 0,
    ));
    if (localName.toLowerCase() !== path.toLowerCase()) {
      throw new Error(`Package entry path differs between ZIP records: ${path}`);
    }

    entries.push({ path, compressedBytes, expandedBytes, localOffset, method, isDirectory });
    cursor = recordEnd;
  }
  if (cursor !== directoryEnd) throw new Error("Package archive has trailing or unparsed directory data.");
  return entries;
}

function isPe32PlusX64(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 0x40 || bytes[0] !== 0x4d || bytes[1] !== 0x5a) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const peOffset = view.getUint32(0x3c, true);
  if (peOffset < 0x40 || peOffset + 26 > bytes.byteLength) return false;
  if (view.getUint32(peOffset, true) !== 0x00004550) return false;
  const machine = view.getUint16(peOffset + 4, true);
  const optionalHeaderMagic = view.getUint16(peOffset + 24, true);
  return machine === 0x8664 && optionalHeaderMagic === 0x020b;
}

function isScriptOrCommand(path: string): boolean {
  return /\.(?:ps1|psm1|psd1|ps1xml|bat|cmd|com|vbs|vbe|js|jse|wsf|wsh|hta|reg)$/i.test(path);
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function directoryName(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index + 1);
}

/**
 * Inspects a bounded .nupkg ZIP and returns only directly embedded PE32+ x64 EXEs.
 * No Chocolatey PowerShell, MSI, batch file, or package URL is executed or followed.
 */
export async function inspectChocolateyArchive(file: File): Promise<ChocolateyArchiveInspection> {
  if (!file.name.toLowerCase().endsWith(".nupkg")) throw new Error("Installer inspection only accepts a saved .nupkg archive.");
  if (file.size < 4 || file.size > MAX_ARCHIVE_BYTES) {
    throw new Error(`Package archive must be between 4 bytes and ${Math.round(MAX_ARCHIVE_BYTES / 1024 / 1024)} MB.`);
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b || ![0x03, 0x05, 0x07].includes(bytes[2] ?? -1)) {
    throw new Error("Saved package is not a ZIP-formatted .nupkg archive.");
  }
  const directory = inspectZipDirectory(bytes);
  let unzipped: Record<string, Uint8Array>;
  try {
    unzipped = unzipSync(bytes);
  } catch (error) {
    throw new Error(`Could not extract the package ZIP: ${error instanceof Error ? error.message : String(error)}`);
  }

  const extracted = new Map<string, Uint8Array>();
  for (const [path, content] of Object.entries(unzipped)) {
    const normalized = safeArchivePath(path).replace(/\/$/, "");
    extracted.set(normalized.toLowerCase(), content);
  }

  const executables: EmbeddedGuestExecutable[] = [];
  const unsupportedExecutables: string[] = [];
  let skippedScripts = 0;
  for (const entry of directory) {
    if (entry.isDirectory) continue;
    if (isScriptOrCommand(entry.path)) {
      skippedScripts += 1;
      continue;
    }
    if (!/\.exe$/i.test(entry.path)) continue;
    const executableBytes = extracted.get(entry.path.toLowerCase());
    if (!executableBytes || executableBytes.byteLength !== entry.expandedBytes) {
      throw new Error(`Extracted bytes did not match the package directory record: ${entry.path}`);
    }
    if (!isPe32PlusX64(executableBytes)) {
      unsupportedExecutables.push(entry.path);
      continue;
    }
    if (executables.length >= MAX_EXECUTABLES) {
      throw new Error(`Package contains more than ${MAX_EXECUTABLES} executable candidates.`);
    }

    const parent = directoryName(entry.path);
    const payload: PackagePayloadFile[] = [{
      path: entry.path,
      name: basename(entry.path),
      bytes: executableBytes,
    }];
    const payloadNames = new Set([basename(entry.path).toLowerCase()]);
    let supportTotal = executableBytes.byteLength;
    for (const companion of directory) {
      if (
        companion.isDirectory ||
        companion.path === entry.path ||
        directoryName(companion.path) !== parent ||
        /\.exe$/i.test(companion.path) ||
        isScriptOrCommand(companion.path)
      ) continue;
      const name = basename(companion.path);
      const key = name.toLowerCase();
      if (payloadNames.has(key) || payload.length >= MAX_SUPPORT_FILES) continue;
      const content = extracted.get(companion.path.toLowerCase());
      if (!content || content.byteLength !== companion.expandedBytes) continue;
      if (supportTotal + content.byteLength > MAX_FILE_BYTES) continue;
      payloadNames.add(key);
      supportTotal += content.byteLength;
      payload.push({ path: companion.path, name, bytes: content });
    }
    executables.push({
      archivePath: entry.path,
      name: basename(entry.path),
      sizeBytes: executableBytes.byteLength,
      payload,
    });
  }

  return { executables, unsupportedExecutables, skippedScripts };
}
