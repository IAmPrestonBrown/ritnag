import { MossClient, type SessionIndex } from "@moss-js/moss";
import type { Memory } from "../../shared/schemas";

export interface MossStatus {
  configured: boolean;
  ready: boolean;
  docCount: number;
  lastError: string | null;
  lastPushAt: number | null;
  pushPending: boolean;
}

export interface Hit {
  id: string;
  score: number;
}

const INDEX_NAME = () => process.env.MOSS_INDEX_NAME || "imp-memories";
const PUSH_DEBOUNCE_MS = 3000;

/** What gets embedded for a memory: the question it answers plus the fact itself. */
const docText = (m: Memory) => (m.canonicalQuestion ? `${m.canonicalQuestion}\n${m.factualAnswer}` : m.factualAnswer);

/**
 * Moss is a searchable index over memories, never the source of truth. Doc ids are the local
 * memory ids, so every hit resolves back to an authoritative record in the local store.
 *
 * A SessionIndex embeds and queries in-process, so a just-taught answer is searchable at once;
 * the cloud index is a mirror pushed in the background.
 */
export class MossIndex {
  private client: MossClient | null = null;
  private session: SessionIndex | null = null;
  private pushTimer: NodeJS.Timeout | null = null;
  /** In-flight rebuild. The first one downloads the embedding model, so it can take a while. */
  private building: Promise<boolean> | null = null;
  private status: MossStatus = {
    configured: Boolean(process.env.MOSS_PROJECT_ID && process.env.MOSS_PROJECT_KEY),
    ready: false,
    docCount: 0,
    lastError: null,
    lastPushAt: null,
    pushPending: false,
  };

  constructor(private readonly onChange: () => void = () => {}) {}

  getStatus(): MossStatus {
    return { ...this.status };
  }

  private fail(where: string, err: unknown) {
    const message = `${where}: ${err instanceof Error ? err.message : String(err)}`;
    console.error(`[moss] ${message}`);
    this.status.lastError = message;
    this.onChange();
  }

  /** Rebuilds the index from authoritative local memories. Also the "Rebuild index" action. */
  rebuild(memories: Memory[]): Promise<boolean> {
    if (!this.status.configured) return Promise.resolve(false);
    const run = (this.building ?? Promise.resolve(true)).then(() => this.doRebuild(memories));
    this.building = run.finally(() => {
      if (this.building === guarded) this.building = null;
    });
    const guarded = this.building;
    return run;
  }

  /** Waits for any in-flight build so writes and queries never race it. */
  private async ready(): Promise<SessionIndex | null> {
    if (this.building) await this.building.catch(() => {});
    return this.session;
  }

  private async doRebuild(memories: Memory[]): Promise<boolean> {
    try {
      this.client ??= new MossClient(process.env.MOSS_PROJECT_ID!, process.env.MOSS_PROJECT_KEY!);
      // A fresh session starts empty; we fill it from local records rather than trusting the cloud copy.
      // Detach the old session before closing it, and cancel any pending push, so nothing (the push
      // timer, a concurrent query) can touch a closed SessionIndex in the gap before the new one opens.
      const old = this.session;
      this.session = null;
      if (this.pushTimer) clearTimeout(this.pushTimer);
      this.pushTimer = null;
      await old?.close?.();
      this.session = await this.client.session(INDEX_NAME());
      if (memories.length) await this.session.addDocs(memories.map(toDoc), { upsert: true });
      this.status = { ...this.status, ready: true, docCount: this.session.docCount, lastError: null };
      console.log(`[moss] index ready: ${this.session.docCount} docs`);
      this.schedulePush();
      this.onChange();
      return true;
    } catch (err) {
      this.status.ready = false;
      this.fail("rebuild failed", err);
      return false;
    }
  }

  async upsert(m: Memory): Promise<boolean> {
    if (!this.status.configured) return false;
    const session = await this.ready();
    if (!session) {
      this.fail(`index ${m.id} skipped`, "Moss index not ready; rebuild the index");
      return false;
    }
    try {
      await session.addDocs([toDoc(m)], { upsert: true });
      this.status.docCount = session.docCount;
      this.status.lastError = null;
      this.schedulePush();
      this.onChange();
      return true;
    } catch (err) {
      this.fail(`index ${m.id} failed`, err);
      return false;
    }
  }

  async remove(ids: string[]): Promise<void> {
    const session = ids.length ? await this.ready() : null;
    if (!session) return;
    try {
      await session.deleteDocs(ids);
      this.status.docCount = session.docCount;
      this.schedulePush();
      this.onChange();
    } catch (err) {
      this.fail("delete failed", err);
    }
  }

  /** Null means search is unavailable (not configured or erroring); callers must say so. */
  async search(query: string, topK = 8): Promise<Hit[] | null> {
    const session = await this.ready();
    if (!session) return null;
    try {
      const res = await session.query(query, { topK });
      return res.docs.map((d) => ({ id: d.id, score: d.score }));
    } catch (err) {
      this.fail("query failed", err);
      return null;
    }
  }

  private schedulePush() {
    this.status.pushPending = true;
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(() => void this.push(), PUSH_DEBOUNCE_MS);
    this.pushTimer.unref();
  }

  private async push() {
    const session = this.session;
    if (!session) return;
    try {
      if (session.docCount === 0) {
        // Moss rejects pushing an empty index; nothing to mirror yet.
        this.status.pushPending = false;
        return void this.onChange();
      }
      await session.pushIndex();
      this.status.lastPushAt = Date.now();
      this.status.pushPending = false;
      this.onChange();
    } catch (err) {
      // Local session still answers queries; only the cloud mirror is stale.
      this.fail("cloud push failed", err);
    }
  }
}

const toDoc = (m: Memory) => ({
  id: m.id,
  text: docText(m),
  metadata: { kind: m.kind },
});
