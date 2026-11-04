/*
 * Chocolatey Community Repository metadata client.
 *
 * This talks only to the NuGet/OData metadata feed (package IDs, versions,
 * descriptions, tags and project links). It never requests package content,
 * .nupkg files, installer URLs or executables.
 */

import type { ChocolateyPackageMetadata } from "./types";

export const CHOCOLATEY_FEED_URL = "https://community.chocolatey.org/api/v2/Packages()";
const CACHE_KEY = "porthole.ui.chocolatey-metadata.v1";
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 7000;
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

/** Fetch a bounded batch of metadata records, with a twelve-hour local cache fallback. */
export async function fetchChocolateyMetadata(
  entries: readonly ChocolateyCatalogEntry[],
): Promise<ChocolateyMetadataBatch> {
  const expected = new Map(entries.map((entry) => [entry.packageId.toLowerCase(), entry.appId]));
  const packageIds = [...expected.keys()];
  const cache = readCache();
  const cached = cachedFor(packageIds);
  const now = Date.now();
  if (cache && now - cache.savedAt < CACHE_TTL_MS && packageIds.every((id) => cached.has(id))) {
    return {
      records: new Map([...cached.values()].map((record) => [record.packageId.toLowerCase(), record])),
      fetchedAt: cache.savedAt,
      fromCache: true,
      error: null,
    };
  }

  const filter = packageIds.map((id) => `Id eq '${id.replaceAll("'", "''")}'`).join(" or ");
  const url = new URL(CHOCOLATEY_FEED_URL);
  url.searchParams.set("$filter", filter);
  url.searchParams.set("$top", String(Math.max(25, packageIds.length + 5)));

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/atom+xml, application/xml;q=0.9" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Chocolatey metadata request returned HTTP ${response.status}.`);
    const records = parseFeed(await response.text(), expected);
    if (records.size === 0) throw new Error("Chocolatey returned no matching package metadata.");
    const fetchedAt = Date.now();
    saveCache(records, fetchedAt);
    return {
      records: new Map([...records.values()].map((record) => [record.packageId.toLowerCase(), record])),
      fetchedAt,
      fromCache: false,
      error: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      records: cached,
      fetchedAt: cache?.savedAt ?? 0,
      fromCache: cached.size > 0,
      error: message,
    };
  } finally {
    clearTimeout(timeout);
  }
}
