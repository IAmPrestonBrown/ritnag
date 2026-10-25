/**
 * Ritnag keeps everyone anonymous: it never says the owner's or a visitor's name aloud.
 * The prompt asks for that and visitor turns carry no names, but this is the last guard
 * before Cartesia speaks a line.
 */
export interface KnownNames {
  owner: string;
  others: string[];
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const SENTENCE_START = String.raw`(^|[.!?]\s+)`;

const capitalizeAfterStart = (text: string) => text.replace(/(^|[.!?]\s+)([a-z])/g, (_m, lead: string, c: string) => lead + c.toUpperCase());

function dropName(text: string, name: string, replacement: string): string {
  const n = escape(name.trim());
  const word = String.raw`(?<![\w])${n}(?![\w])`;
  return (
    text
      // "Yes, Bob, it's pushed." / "Yes, Bob." -> drop the vocative
      .replace(new RegExp(String.raw`,\s*${word}`, "gi"), "")
      // "Bob, it's pushed." / "Okay Bob, listen" -> drop the name and its comma
      .replace(new RegExp(String.raw`${SENTENCE_START}${word},\s*`, "gi"), "$1")
      .replace(new RegExp(String.raw`\s+${word},`, "gi"), "")
      // anything left is a mention in the third person
      .replace(new RegExp(word, "gi"), replacement)
  );
}

export function stripNames(text: string, names: KnownNames): string {
  let out = text;
  if (names.owner.trim()) out = dropName(out, names.owner, "the owner");
  for (const name of names.others) if (name.trim()) out = dropName(out, name, "someone");
  if (out === text) return text;
  return capitalizeAfterStart(out.replace(/\s{2,}/g, " ").replace(/\s+([,.!?])/g, "$1").trim());
}
