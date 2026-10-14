import { Fragment, type ReactNode } from "react";

// Text-only Markdown: links/images remain labels; HTML is escaped by React.
function inline(text: string): ReactNode[] {
  return text
    .replace(/!?\[([^\]]+)\]\([^\n)]*\)/g, "$1")
    .split(/(\*\*[^*]+\*\*|`[^`]+`)/g)
    .map((part, i) =>
      part.startsWith("**") && part.endsWith("**") ? (
        <strong key={i}>{part.slice(2, -2)}</strong>
      ) : part.startsWith("`") && part.endsWith("`") ? (
        <code key={i} className="rounded bg-muted px-1 text-xs">
          {part.slice(1, -1)}
        </code>
      ) : (
        <Fragment key={i}>{part}</Fragment>
      ),
    );
}
export function AssistantMarkdown({ text }: { text: string }) {
  const lines = text.split(/\r?\n/),
    blocks: ReactNode[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim()) continue;
    if (/^\s*```/.test(line)) {
      const code: string[] = [];
      while (++i < lines.length && !/^\s*```/.test(lines[i]!)) code.push(lines[i]!);
      blocks.push(
        <pre key={i} className="max-w-full overflow-auto rounded-md bg-muted p-3 text-xs">
          <code>{code.join("\n")}</code>
        </pre>,
      );
    } else if (line.trim().startsWith("|") && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? "")) {
      const cells = (row: string) =>
        row
          .trim()
          .replace(/^\||\|$/g, "")
          .split("|");
      const head = cells(line),
        rows: string[][] = [];
      i++;
      while (lines[i + 1]?.trim().startsWith("|")) rows.push(cells(lines[++i]!));
      blocks.push(
        <div key={i} className="max-w-full overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr>
                {head.map((cell, j) => (
                  <th key={j} className="border bg-muted/40 p-2 text-left font-medium">
                    {inline(cell)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, j) => (
                <tr key={j}>
                  {head.map((_, k) => (
                    <td key={k} className="border p-2 align-top">
                      {inline(row[k] ?? "")}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
    } else if (/^\s*(?:[-*+] |\d+[.)] )/.test(line)) {
      const numbered = /^\s*\d+[.)] /.test(line),
        items: string[] = [];
      do {
        items.push(lines[i]!.replace(/^\s*(?:[-*+] |\d+[.)] )/, ""));
        i++;
      } while (i < lines.length && (numbered ? /^\s*\d+[.)] / : /^\s*[-*+] /).test(lines[i]!));
      i--;
      const content = items.map((item, j) => <li key={j}>{inline(item)}</li>);
      blocks.push(
        numbered ? (
          <ol key={i} className="list-decimal space-y-1 pl-5">
            {content}
          </ol>
        ) : (
          <ul key={i} className="list-disc space-y-1 pl-5">
            {content}
          </ul>
        ),
      );
    } else {
      blocks.push(
        <p key={i} className={/^#{1,6} /.test(line) ? "font-semibold" : "whitespace-pre-wrap"}>
          {inline(line.replace(/^#{1,6} /, ""))}
        </p>,
      );
    }
  }
  return <div className="min-w-0 space-y-3 break-words leading-6">{blocks}</div>;
}
