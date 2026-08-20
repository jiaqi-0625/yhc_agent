import type { ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const webAssets = new Map<string, { path: string; type: string }>([
  ["/", { path: fileURLToPath(new URL("../../web/public/index.html", import.meta.url)), type: "text/html; charset=utf-8" }],
  ["/app.css", { path: fileURLToPath(new URL("../../web/public/app.css", import.meta.url)), type: "text/css; charset=utf-8" }],
  ["/agent-panel.css", { path: fileURLToPath(new URL("../../web/public/agent-panel.css", import.meta.url)), type: "text/css; charset=utf-8" }],
  ["/app.js", { path: fileURLToPath(new URL("../../web/public/app.js", import.meta.url)), type: "text/javascript; charset=utf-8" }],
  ["/api-client.js", { path: fileURLToPath(new URL("../../web/public/api-client.js", import.meta.url)), type: "text/javascript; charset=utf-8" }],
  ["/auth-api.js", { path: fileURLToPath(new URL("../../web/public/auth-api.js", import.meta.url)), type: "text/javascript; charset=utf-8" }],
  ["/workspace-api.js", { path: fileURLToPath(new URL("../../web/public/workspace-api.js", import.meta.url)), type: "text/javascript; charset=utf-8" }],
  ["/workspace-shell.js", { path: fileURLToPath(new URL("../../web/public/workspace-shell.js", import.meta.url)), type: "text/javascript; charset=utf-8" }],
  ["/project-library.js", { path: fileURLToPath(new URL("../../web/public/project-library.js", import.meta.url)), type: "text/javascript; charset=utf-8" }],
  ["/project-creation-wizard.js", { path: fileURLToPath(new URL("../../web/public/project-creation-wizard.js", import.meta.url)), type: "text/javascript; charset=utf-8" }],
  ["/agent-api.js", { path: fileURLToPath(new URL("../../web/public/agent-api.js", import.meta.url)), type: "text/javascript; charset=utf-8" }],
  ["/agent-panel.js", { path: fileURLToPath(new URL("../../web/public/agent-panel.js", import.meta.url)), type: "text/javascript; charset=utf-8" }],
]);

export async function sendWebAsset(response: ServerResponse, pathname: string): Promise<boolean> {
  const asset = webAssets.get(pathname);
  if (!asset) return false;
  const content = await readFile(asset.path);
  response.writeHead(200, {
    "content-type": asset.type,
    "content-length": content.byteLength,
    "cache-control": pathname === "/" ? "no-store" : "public, max-age=300",
    "content-security-policy": "default-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  response.end(content);
  return true;
}
