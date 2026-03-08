import fs from "node:fs/promises";
import path from "node:path";

import { ZodType } from "zod";

export class JsonFileStore<T> {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly schema: ZodType<T>,
    private readonly fallback: T
  ) {}

  async ensureFile(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      await fs.access(this.filePath);
    } catch {
      await fs.writeFile(this.filePath, JSON.stringify(this.fallback, null, 2), "utf8");
    }
  }

  async read(): Promise<T> {
    await this.ensureFile();
    const raw = await fs.readFile(this.filePath, "utf8");
    const parsed = JSON.parse(raw);
    return this.schema.parse(parsed);
  }

  async write(value: T): Promise<void> {
    const validated = this.schema.parse(value);
    await fs.writeFile(this.filePath, JSON.stringify(validated, null, 2), "utf8");
  }

  async update<R>(updater: (current: T) => Promise<{ next: T; result: R }> | { next: T; result: R }): Promise<R> {
    let output!: R;

    this.writeQueue = this.writeQueue.then(async () => {
      const current = await this.read();
      const { next, result } = await updater(current);
      await this.write(next);
      output = result;
    });

    await this.writeQueue;
    return output;
  }
}