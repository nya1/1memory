import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export async function withTempJustMemoryHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const previous = process.env.JUSTMEMORY_HOME;
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "justmemory-test-"));
  process.env.JUSTMEMORY_HOME = home;

  try {
    return await fn(home);
  } finally {
    if (previous === undefined) {
      delete process.env.JUSTMEMORY_HOME;
    } else {
      process.env.JUSTMEMORY_HOME = previous;
    }
    await fs.rm(home, { recursive: true, force: true });
  }
}
