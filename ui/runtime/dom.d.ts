/*
 * Host capability typings that TypeScript's DOM lib does not ship yet.
 * These describe browser storage APIs used by runtime/storage.ts; they do not
 * grant the UI any direct storage access.
 */

interface DirectoryPickerOptions {
  id?: string;
  mode?: "read" | "readwrite";
  startIn?: "desktop" | "documents" | "downloads" | "music" | "pictures" | "videos";
}

interface FileSystemDirectoryHandle {
  queryPermission?: (descriptor?: {
    mode?: "read" | "readwrite";
  }) => Promise<PermissionState>;
  requestPermission?: (descriptor?: {
    mode?: "read" | "readwrite";
  }) => Promise<PermissionState>;
}

interface Window {
  showDirectoryPicker?: (
    options?: DirectoryPickerOptions,
  ) => Promise<FileSystemDirectoryHandle>;
}

interface StorageManager {
  getDirectory?: () => Promise<FileSystemDirectoryHandle>;
}
