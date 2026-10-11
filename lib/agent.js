import path from "node:path";
import fs from "node:fs/promises";

export function resolveProjectPath(projectRoot, requestedPath) {
  const root = path.resolve(projectRoot);
  const target = path.resolve(root, String(requestedPath || "."));
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error("Path denied: file operations must stay inside the configured project workspace.");
  }
  return target;
}

export async function operateOnFile({ projectRoot, action, filePath, content, find, replace }) {
  const target = resolveProjectPath(projectRoot, filePath);
  if (action === "read") return { path: filePath, content: await fs.readFile(target, "utf8") };
  if (action === "write") {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, String(content ?? ""), { encoding: "utf8", mode: 0o600 });
    return { path: filePath, written: true };
  }
  if (action === "edit") {
    const current = await fs.readFile(target, "utf8");
    if (typeof find !== "string" || !find.length) throw new Error("Edit requires a non-empty find string.");
    if (!current.includes(find)) throw new Error("Edit failed: target text was not found; file was not changed.");
    const updated = current.replace(find, String(replace ?? ""));
    await fs.writeFile(target, updated, { encoding: "utf8", mode: 0o600 });
    return { path: filePath, edited: true };
  }
  throw new Error("Unsupported file action. Use read, write, or edit.");
}
