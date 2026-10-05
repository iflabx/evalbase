/** Present model prose as escaped text, never executable HTML or model-supplied links. */
export function assistantReply(text: string): string {
  const labels: Record<string, string> = {
    protectedFieldChanges: "受保护字段变化",
    outsideLabels: "超出类别",
    emptyQuestions: "空问题",
    additionalLabels: "其他类别",
    missing_output: "缺少候选",
    duplicate_content: "完全重复",
  };
  return text
    .replace(/^\s*```[^\n]*\n?|^\s*```\s*$/gm, "")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^\n)]*\)/g, "$1")
    .split("\n")
    .filter((line) => !/^\s*\|[\s:|-]+\|\s*$/.test(line))
    .map((line) =>
      /^\s*\|.*\|\s*$/.test(line)
        ? line
            .trim()
            .slice(1, -1)
            .split("|")
            .map((cell) => cell.trim())
            .join(" · ")
        : line,
    )
    .join("\n")
    .replace(
      /\b(protectedFieldChanges|outsideLabels|emptyQuestions|additionalLabels|missing_output|duplicate_content)\b/g,
      (key) => labels[key] ?? key,
    );
}
