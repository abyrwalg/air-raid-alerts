import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export class AiLogStore {
  constructor({ filePath, retentionDays = 30, clock = Date.now }) {
    this.filePath = filePath;
    this.retentionDays = retentionDays;
    this.clock = clock;
    this.entries = [];
    this.queue = Promise.resolve();
    this.ready = false;
  }

  async initialize() {
    if (this.ready) return;
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const data = JSON.parse(await readFile(this.filePath, 'utf8'));
      if (Array.isArray(data))
        this.entries = data.filter(
          (entry) => entry && typeof entry.id === 'string',
        );
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError))
        throw error;
    }
    this.ready = true;
    await this.prune();
    await this.persist();
  }

  serialize(action) {
    const result = this.queue.then(action);
    this.queue = result.catch(() => {});
    return result;
  }

  async persist() {
    const temporary = `${this.filePath}.tmp`;
    await writeFile(temporary, JSON.stringify(this.entries), 'utf8');
    await rename(temporary, this.filePath);
  }

  prune() {
    const cutoff = this.clock() - this.retentionDays * 24 * 60 * 60 * 1000;
    this.entries = this.entries.filter(
      (entry) => Date.parse(entry.startedAt) >= cutoff,
    );
  }

  pruneAndSave() {
    return this.serialize(async () => {
      if (!this.ready) return;
      this.prune();
      await this.persist();
    });
  }

  upsert(entry) {
    return this.serialize(async () => {
      if (!this.ready) await this.initialize();
      const index = this.entries.findIndex(
        (candidate) => candidate.id === entry.id,
      );
      if (index === -1) this.entries.push(entry);
      else this.entries[index] = entry;
      this.prune();
      await this.persist();
      return entry;
    });
  }

  list() {
    if (!this.ready) throw new Error('AI log store is not initialized.');
    return this.entries;
  }

  get(id) {
    return this.list().find((entry) => entry.id === id) || null;
  }

  async close() {
    await this.queue;
    if (this.ready) await this.persist();
  }
}
