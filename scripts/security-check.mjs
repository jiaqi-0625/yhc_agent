import { readFile, readdir } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const includedExtensions = new Set([".ts", ".mjs", ".json", ".md", ".yml", ".yaml", ".example"]);
const ignoredDirectories = new Set([".git", "node_modules", "coverage", "dist"]);
const ignoredFiles = new Set(["package-lock.json"]);
const patterns = [
  { name: "private key", expression: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: "OpenAI-style secret", expression: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { name: "AWS access key", expression: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "GitHub token", expression: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
];

async function collect(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collect(path)));
    if (entry.isFile() && !ignoredFiles.has(entry.name) && includedExtensions.has(extname(entry.name))) files.push(path);
  }
  return files;
}

const findings = [];
for (const file of await collect(root)) {
  const content = await readFile(file, "utf8");
  for (const pattern of patterns) {
    if (pattern.expression.test(content)) findings.push(`${relative(root, file)}: ${pattern.name}`);
  }
}

if (findings.length > 0) {
  console.error("Credential-pattern scan failed:\n" + findings.join("\n"));
  process.exitCode = 1;
} else {
  console.log("Credential-pattern scan passed.");
}
