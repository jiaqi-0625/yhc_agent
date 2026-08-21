import type { ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";

import { findMockCompanyAssetMedia } from "@firefly/tools";

const mediaPath = /^\/v1\/mock-company-assets\/(?<assetId>[A-Za-z0-9_-]{1,128})\/versions\/(?<version>[1-9][0-9]*)\/thumbnail$/u;

export async function sendMockCompanyAssetMedia(
  response: ServerResponse,
  pathname: string,
  mediaRoot = process.env.MOCK_COMPANY_ASSET_MEDIA_ROOT ?? ".data/mock-company-assets",
): Promise<boolean> {
  const match = mediaPath.exec(pathname);
  if (match?.groups === undefined) return false;

  const entry = findMockCompanyAssetMedia(
    match.groups.assetId ?? "",
    Number(match.groups.version),
  );
  if (entry === undefined) {
    response.writeHead(404, { "cache-control": "no-store" });
    response.end();
    return true;
  }

  const absoluteRoot = resolve(mediaRoot);
  const absolutePath = resolve(absoluteRoot, ...entry.relativePath.split("/"));
  if (!absolutePath.startsWith(`${absoluteRoot}${sep}`)) {
    response.writeHead(404, { "cache-control": "no-store" });
    response.end();
    return true;
  }

  let content: Buffer;
  try {
    content = await readFile(absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    response.writeHead(404, { "cache-control": "no-store" });
    response.end();
    return true;
  }
  if (content.byteLength !== entry.byteSize) {
    response.writeHead(500, { "cache-control": "no-store" });
    response.end();
    return true;
  }

  response.writeHead(200, {
    "content-type": entry.mediaType,
    "content-length": content.byteLength,
    "cache-control": "public, max-age=31536000, immutable",
    "x-content-type-options": "nosniff",
  });
  response.end(content);
  return true;
}
