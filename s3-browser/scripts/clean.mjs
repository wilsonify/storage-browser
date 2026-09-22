import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");

await rm(join(rootDir, "dist"), { recursive: true, force: true });
await rm(join(rootDir, ".sea-build"), { recursive: true, force: true });
