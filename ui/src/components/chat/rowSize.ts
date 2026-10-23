import type { TranscriptRow } from "../../store/agent-reducer";

/**
 * A guess of a transcript row's height, from what it holds, for the rows the virtualiser has not drawn yet.
 *
 * Every row that is first drawn above the view is measured then, and the difference to its guess is added to scrollTop so that the
 * text on screen stays put. A flat guess for every row (one line) was off by hundreds of pixels for an answer of twenty paragraphs,
 * so scrolling up through a long run wrote a big correction on almost every step, and each write fights the scroll in progress. The
 * closer the guess, the smaller and rarer those writes. It need not be exact: a row is measured for good once it has been drawn.
 */

/** About how many characters of the 14px text fit on a line of the message column (880px wide at most). */
const CHARS_PER_LINE = 118;
const LINE_PX = 21;
const PARAGRAPH_GAP_PX = 3;
/** What a row holds besides its text: the name line, the padding and the gap to the next row. An answer, and a message of yours. */
const ANSWER_CHROME_PX = 32;
const USER_CHROME_PX = 51;

/** Lines of wrapped text and the paragraph breaks between them (blank lines are the breaks). */
function textSize(text: string): number {
  let lines = 0;
  let breaks = 0;
  for (const paragraph of text.split(/\n{2,}/)) {
    const wrapped = paragraph.split("\n").reduce((n, line) => n + Math.max(1, Math.ceil(line.length / CHARS_PER_LINE)), 0);
    lines += wrapped;
    breaks++;
  }
  return lines * LINE_PX + Math.max(0, breaks - 1) * PARAGRAPH_GAP_PX;
}

export function estimateRow(row: TranscriptRow | undefined): number {
  const item = row?.item;
  if (!item) return 72;
  switch (item.type) {
    case "user":
      return USER_CHROME_PX + textSize(item.text);
    case "text":
      return ANSWER_CHROME_PX + textSize(item.text);
    case "thinking":
      return 40;
    case "tool":
      return 34 + row.children.length * 30;
    case "turn":
      return 9;
    case "note":
      return 56;
    case "error":
      return 84;
    case "permission":
    case "question":
    case "plan":
      return 160;
    default:
      return 72;
  }
}
