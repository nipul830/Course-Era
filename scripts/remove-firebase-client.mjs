import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("../", import.meta.url).pathname;
for (const name of readdirSync(root)) {
  if (!name.endsWith(".html")) continue;
  const file = join(root, name);
  const source = readFileSync(file, "utf8");
  const updated = source
    .replace(/\s*<script[^>]+src=["']https:\/\/www\.gstatic\.com\/firebase[^"']+["'][^>]*><\/script>/gi, "")
    .replace(/\s*<script[^>]+src=["']https:\/\/www\.gstatic\.com\/firebasejs[^"']+["'][^>]*><\/script>/gi, "");
  if (updated !== source) writeFileSync(file, updated);
}
console.log("FIREBASE_CLIENT_SDK_TAGS_REMOVED=OK");
