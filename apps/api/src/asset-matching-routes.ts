import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import {
  AssetReferenceSchema,
  type AssetCategory,
  type AssetReference,
} from "@firefly/schemas";
import { Type } from "typebox";

import type { AssetMatchingRuntime } from "./asset-matching-runtime.ts";
import { BusinessRuntimeError } from "./business-runtime.ts";
import { readJson, readJsonWithLimit, sendJson, validateBody } from "./http-boundary.ts";
import { resolveWorkspaceSession } from "./workspace-session-routes.ts";
import type { WorkspaceSessionRuntime } from "./workspace-session-runtime.ts";

const IdentifierPath = "([A-Za-z0-9_-]{1,128})";
const TaskBase = `/v1/workspace/batch-projects/${IdentifierPath}/video-tasks/${IdentifierPath}`;
const MatchingPath = new RegExp(`^${TaskBase}/asset-matching$`, "u");
const TemporaryUploadPath = new RegExp(
  `^/v1/workspace/batch-projects/${IdentifierPath}/temporary-assets$`,
  "u",
);
const LockSelectionSchema = Type.Object({
  expectedTaskRevision: Type.Integer({ minimum: 1 }),
  selectedAssets: Type.Array(AssetReferenceSchema, { minItems: 1, maxItems: 500 }),
}, { additionalProperties: false });
const UploadSchema = Type.Object({
  fileName: Type.String({ minLength: 1, maxLength: 255, pattern: "^[^\\\\/\\r\\n]+$" }),
  fileBase64: Type.String({ minLength: 4, maxLength: 11_200_000 }),
  category: Type.Union([Type.Literal("person"), Type.Literal("scene"), Type.Literal("visual_style")]),
  sourceDescription: Type.String({ minLength: 1, maxLength: 2000 }),
  rightsDeclaration: Type.String({ minLength: 1, maxLength: 2000 }),
  rightsConfirmed: Type.Literal(true),
}, { additionalProperties: false });

interface UploadBody {
  fileName: string;
  fileBase64: string;
  category: Exclude<AssetCategory, "vehicle">;
  sourceDescription: string;
  rightsDeclaration: string;
  rightsConfirmed: true;
}

function assertNoQuery(url: URL): void {
  const first = url.searchParams.keys().next();
  if (!first.done) {
    throw new BusinessRuntimeError("AIC-API-QUERY_INVALID", "不支持此查询参数。", 400);
  }
}

function pngDimensions(buffer: Buffer): { width: number; height: number } | undefined {
  if (buffer.length < 24 || buffer.toString("hex", 0, 8) !== "89504e470d0a1a0a") return undefined;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function jpegDimensions(buffer: Buffer): { width: number; height: number } | undefined {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return undefined;
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) { offset += 1; continue; }
    const marker = buffer[offset + 1]!;
    if (marker === 0xd8 || marker === 0xd9) { offset += 2; continue; }
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > buffer.length) return undefined;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  return undefined;
}

function webpDimensions(buffer: Buffer): { width: number; height: number } | undefined {
  if (
    buffer.length < 30 ||
    buffer.toString("ascii", 0, 4) !== "RIFF" ||
    buffer.toString("ascii", 8, 12) !== "WEBP"
  ) return undefined;
  const kind = buffer.toString("ascii", 12, 16);
  if (kind === "VP8X") {
    return {
      width: 1 + buffer.readUIntLE(24, 3),
      height: 1 + buffer.readUIntLE(27, 3),
    };
  }
  if (kind === "VP8 " && buffer.length >= 30) {
    return {
      width: buffer.readUInt16LE(26) & 0x3fff,
      height: buffer.readUInt16LE(28) & 0x3fff,
    };
  }
  if (kind === "VP8L" && buffer.length >= 25 && buffer[20] === 0x2f) {
    const bits = buffer.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  return undefined;
}

export function inspectTemporaryImage(fileName: string, fileBase64: string) {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(fileBase64)) {
    throw new BusinessRuntimeError("AIC-ASSET-UPLOAD_INVALID", "素材文件编码无效。", 400);
  }
  const buffer = Buffer.from(fileBase64, "base64");
  if (buffer.length < 1 || buffer.length > 8 * 1024 * 1024) {
    throw new BusinessRuntimeError("AIC-ASSET-UPLOAD_SIZE_INVALID", "图片大小需在 8MB 以内。", 400);
  }
  const png = pngDimensions(buffer);
  const jpeg = png === undefined ? jpegDimensions(buffer) : undefined;
  const webp = png === undefined && jpeg === undefined ? webpDimensions(buffer) : undefined;
  const dimensions = png ?? jpeg ?? webp;
  if (!dimensions || dimensions.width < 1 || dimensions.height < 1) {
    throw new BusinessRuntimeError("AIC-ASSET-UPLOAD_FORMAT_INVALID", "仅支持有效的 JPG、PNG 或 WebP 图片。", 400);
  }
  return {
    fileName,
    mediaType: png ? "image/png" : jpeg ? "image/jpeg" : "image/webp",
    byteSize: buffer.length,
    width: dimensions.width,
    height: dimensions.height,
    checksumSha256: createHash("sha256").update(buffer).digest("hex"),
  };
}

export function matchesAssetRoute(pathname: string): boolean {
  return MatchingPath.test(pathname) || TemporaryUploadPath.test(pathname);
}

export async function handleAssetMatchingRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  runtime: AssetMatchingRuntime,
  sessions: WorkspaceSessionRuntime,
): Promise<boolean> {
  const matching = MatchingPath.exec(url.pathname);
  const temporaryUpload = TemporaryUploadPath.exec(url.pathname);
  if (!matching && !temporaryUpload) return false;
  assertNoQuery(url);
  const session = await resolveWorkspaceSession(request, sessions);
  if (matching?.[1] && matching[2]) {
    if (request.method === "GET") {
      sendJson(response, 200, await runtime.getView(matching[1], matching[2], session.scope));
      return true;
    }
    if (request.method === "POST") {
      const body = validateBody<{ expectedTaskRevision: number; selectedAssets: AssetReference[] }>(
        LockSelectionSchema,
        await readJson(request),
      );
      sendJson(
        response,
        200,
        await runtime.lockSelection(
          matching[1],
          matching[2],
          body.expectedTaskRevision,
          body.selectedAssets,
          session.scope,
        ),
      );
      return true;
    }
  }
  if (temporaryUpload?.[1] && request.method === "POST") {
    const body = validateBody<UploadBody>(UploadSchema, await readJsonWithLimit(request, 12 * 1024 * 1024));
    const inspection = inspectTemporaryImage(body.fileName, body.fileBase64);
    sendJson(response, 201, {
      asset: await runtime.uploadTemporary(
        temporaryUpload[1],
        inspection,
        {
          category: body.category,
          sourceDescription: body.sourceDescription,
          rightsDeclaration: body.rightsDeclaration,
          rightsConfirmed: true,
        },
        session.scope,
      ),
    });
    return true;
  }
  return false;
}
