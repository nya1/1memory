import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export async function withTempOneMemoryHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const previous = process.env.ONEMEMORY_HOME;
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "1memory-test-"));
  process.env.ONEMEMORY_HOME = home;

  try {
    return await fn(home);
  } finally {
    if (previous === undefined) {
      delete process.env.ONEMEMORY_HOME;
    } else {
      process.env.ONEMEMORY_HOME = previous;
    }
    await fs.rm(home, { recursive: true, force: true });
  }
}
