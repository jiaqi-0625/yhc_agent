import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import {
  extname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";

import type {
  MockCompanyAssetMediaManifestEntry,
  MockCompanyAssetImageMediaType,
} from "@firefly/tools";

const maximumMediaBytes = 8 * 1024 * 1024;

export class DevelopmentCompanyAssetMediaUnavailableError extends Error {
  readonly code = "AIC-MOCK-ASSET-MEDIA_UNAVAILABLE";

  constructor() {
    super("The development company asset media is unavailable or failed integrity validation.");
    this.name = "DevelopmentCompanyAssetMediaUnavailableError";
  }
}

export interface DevelopmentCompanyAssetMedia {
  readonly content: Buffer;
  readonly mediaType: MockCompanyAssetImageMediaType;
  readonly byteSize: number;
  readonly etag: string;
}

export interface DevelopmentCompanyAssetMediaReader {
  read(
    entry: Readonly<MockCompanyAssetMediaManifestEntry>,
    signal?: AbortSignal,
  ): Promise<DevelopmentCompanyAssetMedia>;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function assertSafeManifestPath(entry: Readonly<MockCompanyAssetMediaManifestEntry>): string[] {
  const path = entry.relativePath;
  if (
    path.length === 0 ||
    path.includes("\0") ||
    path.includes("\\") ||
    path.includes(":") ||
    path.startsWith("/") ||
    isAbsolute(path)
  ) {
    throw new DevelopmentCompanyAssetMediaUnavailableError();
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new DevelopmentCompanyAssetMediaUnavailableError();
  }
  const extension = extname(path).toLocaleLowerCase("en-US");
  if (
    (entry.mediaType === "image/jpeg" && extension !== ".jpg" && extension !== ".jpeg") ||
    (entry.mediaType === "image/webp" && extension !== ".webp")
  ) {
    throw new DevelopmentCompanyAssetMediaUnavailableError();
  }
  return segments;
}

function isWithinRoot(root: string, file: string): boolean {
  const relativePath = relative(root, file);
  return relativePath.length > 0 &&
    !isAbsolute(relativePath) &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${sep}`);
}

function hasExpectedMagic(content: Buffer, mediaType: MockCompanyAssetImageMediaType): boolean {
  if (mediaType === "image/jpeg") {
    return content.length >= 3 &&
      content[0] === 0xff &&
      content[1] === 0xd8 &&
      content[2] === 0xff;
  }
  return content.length >= 12 &&
    content.subarray(0, 4).toString("ascii") === "RIFF" &&
    content.subarray(8, 12).toString("ascii") === "WEBP";
}

export class DevelopmentCompanyAssetMediaStore implements DevelopmentCompanyAssetMediaReader {
  readonly #rootDirectory: string;

  constructor(rootDirectory: string) {
    if (rootDirectory.trim().length === 0) {
      throw new Error("The development company asset media directory cannot be blank.");
    }
    this.#rootDirectory = resolve(rootDirectory);
  }

  async read(
    entry: Readonly<MockCompanyAssetMediaManifestEntry>,
    signal?: AbortSignal,
  ): Promise<DevelopmentCompanyAssetMedia> {
    try {
      if (signal?.aborted === true) throw new DOMException("Aborted", "AbortError");
      const segments = assertSafeManifestPath(entry);
      const root = await realpath(this.#rootDirectory);
      const candidate = resolve(root, ...segments);
      const file = await realpath(candidate);
      if (!isWithinRoot(root, file)) {
        throw new DevelopmentCompanyAssetMediaUnavailableError();
      }
      const metadata = await stat(file);
      if (
        !metadata.isFile() ||
        metadata.size !== entry.byteSize ||
        metadata.size < 1 ||
        metadata.size > maximumMediaBytes
      ) {
        throw new DevelopmentCompanyAssetMediaUnavailableError();
      }
      const content = await readFile(file, { signal });
      if (
        content.byteLength !== entry.byteSize ||
        !hasExpectedMagic(content, entry.mediaType) ||
        createHash("sha256").update(content).digest("hex") !== entry.checksumSha256
      ) {
        throw new DevelopmentCompanyAssetMediaUnavailableError();
      }
      return {
        content,
        mediaType: entry.mediaType,
        byteSize: entry.byteSize,
        etag: `"sha256-${entry.checksumSha256}"`,
      };
    } catch (error) {
      if (isAbortError(error)) throw error;
      if (error instanceof DevelopmentCompanyAssetMediaUnavailableError) throw error;
      throw new DevelopmentCompanyAssetMediaUnavailableError();
    }
  }
}


