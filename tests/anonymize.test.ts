import { describe, expect, it } from "vitest";
import { stripNames } from "../server/anonymize";

const names = { owner: "Preston", others: ["Bob", "Maya"] };

describe("stripNames", () => {
  it("drops a name used to address someone", () => {
    expect(stripNames("Yes, Bob, it's pushed.", names)).toBe("Yes, it's pushed.");
    expect(stripNames("Yes, Bob. It's pushed.", names)).toBe("Yes. It's pushed.");
    expect(stripNames("Bob, it's pushed.", names)).toBe("It's pushed.");
  });

  it("turns the owner's name into 'the owner'", () => {
    expect(stripNames("You'll have to ask Preston that one.", names)).toBe("You'll have to ask the owner that one.");
    expect(stripNames("Preston said it in the 4 pm call.", names)).toBe("The owner said it in the 4 pm call.");
  });

  it("matches whole words only, any case, and leaves name-free text alone", () => {
    expect(stripNames("Bobby tables, MAYA.", names)).toBe("Bobby tables.");
    expect(stripNames("Table 42.", names)).toBe("Table 42.");
  });

  it("ignores empty names and regex characters in names", () => {
    expect(stripNames("Yes, it's pushed.", { owner: "", others: ["", "A.J"] })).toBe("Yes, it's pushed.");
    expect(stripNames("Thanks, AxJ.", { owner: "", others: ["A.J"] })).toBe("Thanks, AxJ.");
    expect(stripNames("Thanks, A.J.", { owner: "", others: ["A.J"] })).toBe("Thanks.");
  });
});
