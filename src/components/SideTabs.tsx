import { useEffect, useState } from "react";
import type { Snapshot } from "../../shared/events";
import { MemoryPanel, PeoplePanel, TranscriptPanel } from "./Panels";

type Tab = "memory" | "people" | "transcript";
const KEY = "imp.sideTab";

/** Memory, people and transcript in one card instead of three stacked panels. The tab is remembered. */
export function SideTabs({
  snapshot,
  highlight,
  partial,
  tab: forced = null,
}: {
  snapshot: Snapshot;
  highlight: string[];
  partial: { speakerLabel: string; text: string } | null;
  /** switch to this tab when it changes (the director's `tab` command) */
  tab?: Tab | null;
}) {
  const [tab, setTab] = useState<Tab>(() => {
    try {
      const t = localStorage.getItem(KEY);
      return t === "people" || t === "transcript" ? t : "memory";
    } catch {
      return "memory";
    }
  });
  useEffect(() => {
    if (forced) setTab(forced);
  }, [forced]);
  useEffect(() => {
    try {
      localStorage.setItem(KEY, tab);
    } catch {}
  }, [tab]);

  const now = Date.now();
  const memories = snapshot.memories.filter((m) => !m.supersededBy && (m.validUntil === null || m.validUntil > now)).length;
  const tabs: [Tab, string, number | null][] = [
    ["memory", "Memory", memories],
    ["people", "People", snapshot.people.length],
    ["transcript", "Transcript", null],
  ];

  return (
    <section className="card tabs">
      <div className="tab-bar" role="tablist">
        {tabs.map(([id, label, count]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}>
            {label}
            {count !== null && count > 0 && <span className="tab-count"> ({count})</span>}
          </button>
        ))}
      </div>
      <div className="tab-body" role="tabpanel">
        {tab === "memory" && <MemoryPanel snapshot={snapshot} highlight={highlight} />}
        {tab === "people" && <PeoplePanel snapshot={snapshot} />}
        {tab === "transcript" && <TranscriptPanel snapshot={snapshot} partial={partial} />}
      </div>
    </section>
  );
}
