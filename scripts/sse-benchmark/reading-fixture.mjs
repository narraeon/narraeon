export const readingArms = ["short", "long", "history", "dual"];

export const longResponse = Array.from({ length: 20 }, (_, index) => {
  const section = index + 1;
  return [
    `## Watch ${section} at the north pier`,
    `The keeper brings out **ledger ${section}** and opens it beneath the lamp. The harbor bell sounded twice before dawn. One boat reached the north pier with neither cargo nor passengers. The watch changed just after the rain and both lamps were still burning. She turns the page toward you so you can copy the entry before she shuts the ledger. 守夜人把潮汐和来船的时间写在同一页上。`,
    `- Record ${section} keeps the time of the bell.\n- Slip ${section} keeps the name on the lantern.`,
  ].join("\n\n");
}).join("\n\n");

// The synthetic fixture uses these three Markdown punctuation characters only
// for formatting. Count displayed content across text nodes and block breaks.
export function normalizeStory(text) {
  return text.replace(/[#*\s-]/g, "");
}
