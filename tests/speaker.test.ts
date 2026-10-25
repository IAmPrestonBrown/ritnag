import { describe, expect, it } from "vitest";
import { resolveSpeaker } from "../src/audio/devices";

describe("resolveSpeaker", () => {
  const outputs = [
    { deviceId: "builtin", label: "MacBook Pro Speakers" },
    { deviceId: "airpods", label: "AirPods Pro" },
  ];

  it("uses the remembered output while it's connected", () => {
    expect(resolveSpeaker(outputs, "builtin")).toBe("builtin");
  });

  it("falls back to the system default when nothing is picked or the output is gone", () => {
    expect(resolveSpeaker(outputs, "")).toBe("");
    expect(resolveSpeaker(outputs, "unplugged-usb-speaker")).toBe("");
  });
});
