/*
 * Chocolatey Community Repository client.
 *
 * Metadata refresh/search and archive download are separated from the bounded
 * installer inspector. This module fetches and validates .nupkg bytes only; the
 * Store can later expose a direct embedded x64 EXE for explicit guest-only launch.
 * Package scripts, MSI files and external installer URLs are never run or followed.
 */

import type { ChocolateyPackageMetadata } from "./types";

export const CHOCOLATEY_FEED_URL = "https://community.chocolatey.org/api/v2/Packages()";
const CACHE_KEY = "porthole.ui.chocolatey-metadata.v1";
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 7000;
export const MAX_CHOCOLATEY_PACKAGE_BYTES = 256 * 1024 * 1024;
const DATA_NS = "http://schemas.microsoft.com/ado/2007/08/dataservices";
const META_NS = "http://schemas.microsoft.com/ado/2007/08/dataservices/metadata";
const ATOM_NS = "http://www.w3.org/2005/Atom";

export interface ChocolateyCatalogEntry {
  appId: string;
  packageId: string;
}

export interface ChocolateyMetadataBatch {
  records: Map<string, ChocolateyPackageMetadata>;
  fetchedAt: number;
  fromCache: boolean;
  error: string | null;
}

interface CachedMetadata {
  savedAt: number;
  records: Record<string, ChocolateyPackageMetadata>;
}

function readCache(): CachedMetadata | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const candidate = parsed as Partial<CachedMetadata>;
    if (typeof candidate.savedAt !== "number" || !candidate.records || typeof candidate.records !== "object") {
      return null;
    }
    return candidate as CachedMetadata;
  } catch {
    return null;
  }
}

function saveCache(records: Map<string, ChocolateyPackageMetadata>, savedAt: number): void {
  try {
    const object = Object.fromEntries(records.entries());
    localStorage.setItem(CACHE_KEY, JSON.stringify({ savedAt, records: object } satisfies CachedMetadata));
  } catch {
    // Metadata is a convenience; a quota/privacy-mode error must not block the store.
  }
}

function field(properties: Element, name: string): string {
  return properties.getElementsByTagNameNS(DATA_NS, name)[0]?.textContent?.trim() ?? "";
}

function parseFeed(xml: string, expected: ReadonlyMap<string, string>): Map<string, ChocolateyPackageMetadata> {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xml, "application/xml");
  if (doc.getElementsByTagName("parsererror").length > 0) {
    throw new Error("Chocolatey returned unreadable package metadata XML.");
  }

  const records = new Map<string, ChocolateyPackageMetadata>();
  const entries = doc.getElementsByTagNameNS(ATOM_NS, "entry");
  const fetchedAt = Date.now();
  for (const entry of Array.from(entries)) {
    const properties = entry.getElementsByTagNameNS(META_NS, "properties")[0];
    if (!properties) continue;
    const packageId = field(properties, "Id");
    const appId = expected.get(packageId.toLowerCase());
    if (!packageId || !appId) continue;

    const downloadText = field(properties, "DownloadCount");
    const downloadCount = downloadText && Number.isFinite(Number(downloadText))
      ? Number(downloadText)
      : null;
    const tags = field(properties, "Tags").split(/\s+/).filter(Boolean);
    records.set(appId, {
      packageId,
      version: field(properties, "Version"),
      title: field(properties, "Title") || packageId,
      summary: field(properties, "Summary"),
      description: field(properties, "Description"),
      projectUrl: field(properties, "ProjectUrl"),
      tags,
      publishedAt: field(properties, "Published"),
      downloadCount,
      fetchedAt,
      source: "Chocolatey Community Repository",
    });
  }
  return records;
}

function cachedFor(packageIds: readonly string[]): Map<string, ChocolateyPackageMetadata> {
  const cache = readCache();
  const out = new Map<string, ChocolateyPackageMetadata>();
  if (!cache) return out;
  const wanted = new Set(packageIds.map((id) => id.toLowerCase()));
  for (const metadata of Object.values(cache.records)) {
    if (wanted.has(metadata.packageId.toLowerCase())) {
      out.set(metadata.packageId.toLowerCase(), metadata);
    }
  }
  return out;
}

/** Fetch each curated ID independently so one noisy package cannot hide the rest of the catalog. */
export async function fetchChocolateyMetadata(
  entries: readonly ChocolateyCatalogEntry[],
): Promise<ChocolateyMetadataBatch> {
  const packageIds = entries.map((entry) => entry.packageId.toLowerCase());
  const cache = readCache();
  const cached = cachedFor(packageIds);
  const now = Date.now();
  if (cache && now - cache.savedAt < CACHE_TTL_MS && packageIds.every((id) => cached.has(id))) {
    return {
      records: cached,
      fetchedAt: cache.savedAt,
      fromCache: true,
      error: null,
    };
  }
  if (entries.length === 0) {
    return { records: new Map(), fetchedAt: now, fromCache: false, error: null };
  }

  const live = new Map<string, ChocolateyPackageMetadata>();
  const failures: string[] = [];
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < entries.length) {
      const entry = entries[nextIndex++];
      if (!entry) continue;
      const packageId = entry.packageId.toLowerCase();
      const url = new URL(CHOCOLATEY_FEED_URL);
      url.searchParams.set("$filter", `Id eq '${entry.packageId.replaceAll("'", "''")}'`);
      url.searchParams.set("$orderby", "Published desc");
      url.searchParams.set("$top", "1");

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const response = await fetch(url, {
          method: "GET",
          headers: { Accept: "application/atom+xml, application/xml;q=0.9" },
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const parsed = parseFeed(await response.text(), new Map([[packageId, entry.appId]]));
        const record = parsed.get(entry.appId);
        if (!record) throw new Error("no matching package metadata");
        live.set(packageId, record);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push(`${entry.packageId}: ${message}`);
      } finally {
        clearTimeout(timeout);
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(4, entries.length) }, () => worker()));
  const records = new Map(cached);
  for (const [packageId, metadata] of live) records.set(packageId, metadata);
  const fetchedAt = live.size > 0 ? Date.now() : cache?.savedAt ?? 0;
  if (live.size > 0) saveCache(records, fetchedAt);
  return {
    records,
    fetchedAt,
    fromCache: live.size === 0 && records.size > 0,
    error: failures.length > 0
      ? `${failures.slice(0, 3).join(" · ")}${failures.length > 3 ? ` · +${failures.length - 3} more` : ""}`
      : null,
  };
}

export interface ChocolateySearchPage {
  packages: ChocolateyPackageMetadata[];
  /** Chocolatey's OData `rel=next` link, validated against the repository origin. */
  nextUrl: string | null;
  totalHits: number | null;
}

const SEARCH_PAGE_SIZE = 24;
const MAX_SEARCH_RESPONSE_CHARS = 5 * 1024 * 1024;

function parseChocolateySearchFeed(xml: string, requestUrl: URL): ChocolateySearchPage {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.getElementsByTagName("parsererror").length > 0) {
    throw new Error("Chocolatey returned unreadable search results.");
  }

  const packages: ChocolateyPackageMetadata[] = [];
  const seen = new Set<string>();
  const fetchedAt = Date.now();
  for (const entry of Array.from(doc.getElementsByTagNameNS(ATOM_NS, "entry"))) {
    const properties = entry.getElementsByTagNameNS(META_NS, "properties")[0];
    if (!properties) continue;
    const packageId = field(properties, "Id");
    if (!packageId || seen.has(packageId.toLowerCase())) continue;
    seen.add(packageId.toLowerCase());

    const downloadText = field(properties, "DownloadCount");
    packages.push({
      packageId,
      version: field(properties, "Version"),
      title: field(properties, "Title") || packageId,
      summary: field(properties, "Summary"),
      description: field(properties, "Description"),
      projectUrl: field(properties, "ProjectUrl"),
      tags: field(properties, "Tags").split(/\\s+/).filter(Boolean),
      publishedAt: field(properties, "Published"),
      downloadCount: downloadText && Number.isFinite(Number(downloadText)) ? Number(downloadText) : null,
      fetchedAt,
      source: "Chocolatey Community Repository",
    });
  }

  const rawNext = Array.from(doc.getElementsByTagNameNS(ATOM_NS, "link"))
    .find((link) => link.getAttribute("rel") === "next")
    ?.getAttribute("href");
  let nextUrl: string | null = null;
  if (rawNext) {
    const candidate = new URL(rawNext, requestUrl);
    if (candidate.protocol === "https:" && candidate.origin === PACKAGE_ORIGIN) {
      nextUrl = candidate.href;
    }
  } else if (packages.length >= SEARCH_PAGE_SIZE) {
    // Some feeds omit the Atom next link; retain the standard OData skip page.
    const candidate = new URL(requestUrl.href);
    candidate.searchParams.set("$skip", String(Number(candidate.searchParams.get("$skip") ?? "0") + packages.length));
    nextUrl = candidate.href;
  }

  const rawCount = doc.getElementsByTagNameNS(META_NS, "count")[0]?.textContent?.trim();
  const count = rawCount === undefined ? Number.NaN : Number(rawCount);
  return {
    packages,
    nextUrl,
    totalHits: Number.isFinite(count) && count >= 0 ? count : null,
  };
}

/** Search the live, paginated Chocolatey Community Repository; this is metadata only. */
export async function searchChocolateyPackages(
  query: string,
  signal?: AbortSignal,
  pageUrl?: string | null,
): Promise<ChocolateySearchPage> {
  const term = query.trim();
  if (term.length < 2) throw new Error("Enter at least two characters to search Chocolatey.");
  if (term.length > 120) throw new Error("Chocolatey search is limited to 120 characters.");

  let url: URL;
  if (pageUrl) {
    url = new URL(pageUrl);
    if (url.protocol !== "https:" || url.origin !== PACKAGE_ORIGIN || url.pathname !== "/api/v2/Search()") {
      throw new Error("Chocolatey returned an invalid pagination link.");
    }
  } else {
    url = new URL("/api/v2/Search()", PACKAGE_ORIGIN);
    url.searchParams.set("searchTerm", `'${term.replaceAll("'", "''")}'`);
    url.searchParams.set("targetFramework", "''");
    url.searchParams.set("includePrerelease", "false");
    url.searchParams.set("$top", String(SEARCH_PAGE_SIZE));
  }

  const controller = new AbortController();
  const relayAbort = (): void => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener("abort", relayAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, {
      method: "GET",
      mode: "cors",
      credentials: "omit",
      redirect: "follow",
      headers: { Accept: "application/atom+xml, application/xml;q=0.9" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Chocolatey search returned HTTP ${response.status}.`);
    if (response.url) {
      const finalUrl = new URL(response.url);
      if (finalUrl.protocol !== "https:" || finalUrl.origin !== PACKAGE_ORIGIN) {
        throw new Error("Chocolatey search redirected outside its HTTPS repository.");
      }
    }
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_SEARCH_RESPONSE_CHARS) {
      throw new Error("Chocolatey search response exceeded the 5 MB safety limit.");
    }
    const xml = await response.text();
    if (xml.length > MAX_SEARCH_RESPONSE_CHARS) {
      throw new Error("Chocolatey search response exceeded the 5 MB safety limit.");
    }
    return parseChocolateySearchFeed(xml, url);
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", relayAbort);
  }
}

export interface ChocolateyPackageDownloadProgress {
  receivedBytes: number;
  totalBytes: number | null;
}

const PACKAGE_ORIGIN = new URL(CHOCOLATEY_FEED_URL).origin;
const PACKAGE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/i;
const PACKAGE_VERSION_PATTERN = /^[a-z0-9][a-z0-9.+_-]{0,127}$/i;

function safePackageSegment(value: string, pattern: RegExp, label: string): string {
  const segment = value.trim();
  if (!pattern.test(segment)) throw new Error(`Invalid Chocolatey ${label}.`);
  return segment;
}

/** Stable filename for a Chocolatey package archive. */
export function chocolateyPackageFileName(packageId: string, version: string): string {
  const id = safePackageSegment(packageId, PACKAGE_ID_PATTERN, "package ID");
  const normalizedVersion = safePackageSegment(version, PACKAGE_VERSION_PATTERN, "package version");
  return `chocolatey-${id}-${normalizedVersion}.nupkg`;
}

/**
 * Download only the NuGet archive from Chocolatey's public package endpoint.
 * Bytes are validated as ZIP data and returned to the caller; this
 * function never extracts the archive, evaluates package scripts or runs an
 * installer. The caller decides which mounted storage to write it to.
 */
export async function downloadChocolateyPackage(
  packageId: string,
  version: string | null,
  signal: AbortSignal,
  onProgress: (progress: ChocolateyPackageDownloadProgress) => void,
): Promise<{ file: File; url: string }> {
  const id = safePackageSegment(packageId, PACKAGE_ID_PATTERN, "package ID");
  const normalizedVersion = version
    ? safePackageSegment(version, PACKAGE_VERSION_PATTERN, "package version")
    : null;
  const endpoint = normalizedVersion
    ? `/api/v2/package/${encodeURIComponent(id)}/${encodeURIComponent(normalizedVersion)}`
    : `/api/v2/package/${encodeURIComponent(id)}`;
  const url = new URL(endpoint, PACKAGE_ORIGIN);
  onProgress({ receivedBytes: 0, totalBytes: null });

  const response = await fetch(url, {
    method: "GET",
    mode: "cors",
    credentials: "omit",
    redirect: "follow",
    headers: { Accept: "application/octet-stream, application/zip;q=0.9" },
    signal,
  });
  if (!response.ok) throw new Error(`Chocolatey package download returned HTTP ${response.status}.`);
  if (response.url && new URL(response.url).protocol !== "https:") {
    throw new Error("Chocolatey redirected the package download to a non-HTTPS URL.");
  }

  const declaredBytes = Number(response.headers.get("content-length"));
  const totalBytes = Number.isFinite(declaredBytes) && declaredBytes > 0 ? declaredBytes : null;
  if (totalBytes !== null && totalBytes > MAX_CHOCOLATEY_PACKAGE_BYTES) {
    throw new Error(`Package is larger than the ${Math.round(MAX_CHOCOLATEY_PACKAGE_BYTES / 1024 / 1024)} MB Store limit.`);
  }

  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;
  if (response.body) {
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        receivedBytes += value.byteLength;
        if (receivedBytes > MAX_CHOCOLATEY_PACKAGE_BYTES) {
          await reader.cancel();
          throw new Error(`Package is larger than the ${Math.round(MAX_CHOCOLATEY_PACKAGE_BYTES / 1024 / 1024)} MB Store limit.`);
        }
        chunks.push(value);
        onProgress({ receivedBytes, totalBytes });
      }
    } finally {
      reader.releaseLock();
    }
  } else {
    const bytes = new Uint8Array(await response.arrayBuffer());
    receivedBytes = bytes.byteLength;
    if (receivedBytes > MAX_CHOCOLATEY_PACKAGE_BYTES) {
      throw new Error(`Package is larger than the ${Math.round(MAX_CHOCOLATEY_PACKAGE_BYTES / 1024 / 1024)} MB Store limit.`);
    }
    chunks.push(bytes);
    onProgress({ receivedBytes, totalBytes });
  }

  if (receivedBytes < 4) throw new Error("Chocolatey returned an empty or truncated package archive.");
  const signature = new Uint8Array(4);
  let signatureBytes = 0;
  for (const chunk of chunks) {
    const count = Math.min(chunk.byteLength, signature.byteLength - signatureBytes);
    signature.set(chunk.subarray(0, count), signatureBytes);
    signatureBytes += count;
    if (signatureBytes === signature.byteLength) break;
  }
  if (signature[0] !== 0x50 || signature[1] !== 0x4b || ![0x03, 0x05, 0x07].includes(signature[2] ?? -1)) {
    throw new Error("Chocolatey did not return a ZIP-formatted .nupkg archive. No file was saved.");
  }

  const fileParts: ArrayBuffer[] = chunks.map((chunk) => {
    if (chunk.buffer instanceof ArrayBuffer && chunk.byteOffset === 0 && chunk.byteLength === chunk.buffer.byteLength) {
      return chunk.buffer;
    }
    const copy = new ArrayBuffer(chunk.byteLength);
    new Uint8Array(copy).set(chunk);
    return copy;
  });
  const file = new File(fileParts, chocolateyPackageFileName(id, normalizedVersion ?? "latest"), {
    type: "application/octet-stream",
  });
  return { file, url: url.href };
}
