/** Idea-bank rows: the pipe tables of a manager-maintained document that have an "Idea" column. Shared by the board and the pages. */

export interface IdeaRow {
  /** 1-based position of the table among the document's idea tables */
  table: number;
  /** 1-based position of the row inside its table (not the rank the manager writes in "#") */
  index: number;
  /** "<table>.<index>", what the approve link carries */
  ref: string;
  /** the row's "Idea" cell */
  idea: string;
  /** every cell by column header */
  cells: Record<string, string>;
}

/** Cells of one markdown table line, or null when the line is not a table line. Same split as the pages' markdown renderer. */
export function tableCells(raw: string): string[] | null {
  const line = raw.replace(/\s+$/, "");
  return /^\|.*\|$/.test(line) ? line.slice(1, -1).split("|").map((c) => c.trim()) : null;
}
export const isRule = (cells: string[]) => cells.every((c) => /^:?-{2,}:?$/.test(c));
export const ideaColumn = (head: string[]) => head.findIndex((c) => c.toLowerCase() === "idea");

export function ideaRows(body: string): IdeaRow[] {
  const out: IdeaRow[] = [];
  let head: string[] | null = null;
  let table = 0;
  let index = 0;
  let col = -1;
  for (const raw of body.split("\n")) {
    const cells = tableCells(raw);
    if (!cells) {
      head = null;
      continue;
    }
    if (isRule(cells)) continue;
    if (!head) {
      head = cells;
      col = ideaColumn(head);
      index = 0;
      if (col >= 0) table++;
      continue;
    }
    if (col < 0) continue;
    index++;
    const idea = cells[col] ?? "";
    if (!idea) continue;
    out.push({ table, index, ref: `${table}.${index}`, idea, cells: Object.fromEntries(head.map((h, i) => [h, cells[i] ?? ""])) });
  }
  return out;
}
