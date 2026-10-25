import { describe, expect, it } from "vitest";
import { alertNotice } from "../src/notify";
import type { Alert, Person } from "../shared/schemas";

const alert: Alert = {
  id: "a_1",
  sessionId: "s",
  personId: "p_maya",
  questionUtteranceId: "u_1",
  reason: "Asked to approve the production rollback",
  createdAt: 0,
  acknowledgedAt: null,
};
const maya: Person = { id: "p_maya", name: "Maya", relationship: "teammate", tone: "friendly", priority: true, ownerConfiguredAt: 0 };

describe("alertNotice", () => {
  it("names the asker and gives the reason", () => {
    expect(alertNotice(alert, [maya])).toEqual({
      title: "Maya needs you",
      body: "Asked to approve the production rollback",
    });
  });

  it("falls back to someone for an unidentified asker", () => {
    expect(alertNotice({ ...alert, personId: null }, [maya]).title).toBe("Someone needs you");
  });
});
