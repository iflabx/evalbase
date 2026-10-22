import type { BackgroundFragment } from "./extract-background.js";

export const normalizedExcerpt = (text: string) =>
  text.normalize("NFKC").replace(/\s+/gu, "").toLowerCase();

export type BackgroundSection = {
  code?: string;
  listOrdinal?: true;
  categoryName?: string;
  name: string;
  text: string;
  fragments: number[];
  start: number;
  end: number;
};

/** A bounded index of observable headings/rows, not a semantic document parser. */
export function backgroundSections(fragments: BackgroundFragment[]) {
  const ranges: { start: number; end: number; index: number }[] = [];
  let body = "";
  for (const [i, fragment] of fragments.entries()) {
    const previous = fragments[i - 1];
    if (
      previous &&
      !(
        previous.page === fragment.page &&
        previous.startLine === fragment.startLine &&
        previous.text.length === 2000
      )
    )
      body += "\n";
    const start = body.length;
    body += fragment.text;
    ranges.push({ start, end: body.length, index: fragment.index });
  }
  const entries: {
    code?: string;
    listOrdinal?: true;
    name: string;
    start: number;
    end: number;
    level: number;
    parent?: number;
  }[] = [];
  const stack: number[] = [];
  let parent: { code: string; start: number } | undefined;
  let chineseParent: { code: string; start: number } | undefined;
  let offset = 0;
  let tableColumns = 0;
  let tableName = 0;
  let tableDefinition = 1;
  let malformedTable = false;
  const chinese = (value: string) => {
    const digits = "一二三四五六七八九";
    if (value === "十") return 10;
    if (value.startsWith("十")) return 10 + digits.indexOf(value.slice(1)) + 1;
    if (value.endsWith("十")) return (digits.indexOf(value[0]) + 1) * 10;
    return digits.indexOf(value) + 1;
  };
  const add = (
    name: string,
    level: number,
    code?: string,
    ancestor?: number,
    listOrdinal?: true,
  ) => {
    while (stack.length && entries[stack.at(-1)!].level >= level) {
      const entry = entries[stack.pop()!];
      entry.end = Math.min(entry.end, offset);
    }
    entries.push({
      name: name.trim().replace(/^(?:[-*+]\s+|\d+[.)、]\s+)/u, ""),
      code,
      ...(listOrdinal ? { listOrdinal } : {}),
      start: offset,
      end: body.length,
      level,
      parent: ancestor,
    });
    stack.push(entries.length - 1);
  };
  for (const original of body.split("\n")) {
    const line = original.normalize("NFKC").trim();
    const plain = line.replace(/^#{1,6}\s*/u, "");
    const numbered = plain.match(
      /^([a-z](?:\.\d+)+(?:\.[a-z])?|\d+(?:\.\d+)+)(?=\s|[\p{Script=Han}]|$)\s*(.*)$/iu,
    );
    const letter = plain.match(/^([a-z])\s*\)\s*(.+)$/iu);
    const top = plain.match(/^([一二三四五六七八九十]{1,3})[、.]\s*(.+)$/u);
    const sub = plain.match(/^\(([一二三四五六七八九十]{1,3})\)\s*(.+)$/u);
    if (line.startsWith("|")) {
      const cells = line
        .replace(/^\||\|$/gu, "")
        .split("|")
        .map((v) => v.trim());
      if (
        cells.some((v) =>
          /^(?:类别|分类|意图|名称|category|intent|name)$/iu.test(v),
        ) &&
        cells.some((v) => /^(?:定义|definition)$/iu.test(v))
      ) {
        tableColumns = cells.length;
        tableName = cells.findIndex((v) =>
          /^(?:类别|分类|意图|名称|category|intent|name)$/iu.test(v),
        );
        tableDefinition = cells.findIndex((v) =>
          /^(?:定义|definition)$/iu.test(v),
        );
      } else if (cells.every((v) => /^:?-+:?$/u.test(v))) {
        /* table separator */
      } else if (tableColumns) {
        if (
          cells.length !== tableColumns ||
          !cells[tableName] ||
          !cells[tableDefinition]
        )
          malformedTable = true;
        else {
          add(cells[tableName], 8);
          entries.at(-1)!.end = offset + original.length;
        }
      } else malformedTable = true;
    } else if (numbered) {
      const code = numbered[1];
      add(numbered[2] || code, code.split(".").length, code);
      if (!/\.[a-z]$/iu.test(code)) parent = { code, start: offset };
    } else if (letter && parent) {
      add(
        letter[2],
        parent.code.split(".").length + 1,
        parent.code + "." + letter[1].toLowerCase(),
        parent.start,
      );
    } else if (top && chinese(top[1]) > 0) {
      parent = undefined;
      const code = String(chinese(top[1]));
      add(top[2], 1, code, undefined, true);
      chineseParent = { code, start: offset };
    } else if (sub && chineseParent && chinese(sub[1]) > 0) {
      add(
        sub[2],
        2,
        chineseParent.code + "." + chinese(sub[1]),
        chineseParent.start,
        true,
      );
    } else if (/^#{1,6}\s/u.test(line)) {
      parent = undefined;
      chineseParent = undefined;
      add(plain, line.match(/^#+/u)![0].length);
    } else {
      const start = offset;
      for (const colon of original.matchAll(
        /(?:^|[。；;])([^:：。；;\n]{1,80})[:：]\s*\S/gu,
      )) {
        if (
          /^(?:定义|说明|示例|要求|限制|注意|期望行为|注\d*|\[?来源)$/u.test(
            colon[1].trim(),
          ) ||
          /^(?:(?:本文件|本标准|本规范).*(?:起草|按照|编制)|(?:主要)?起草(?:单位|人))/u.test(
            colon[1].replace(/\s+/gu, ""),
          )
        )
          continue;
        offset = start + colon.index + (/^[。；;]/u.test(colon[0]) ? 1 : 0);
        add(colon[1], 8);
      }
      offset = start;
    }
    offset += original.length + 1;
  }
  const sections: BackgroundSection[] = entries.map((entry) => {
    // A heading locates evidence; its ordinal or field label is not the business value.
    const line = body
      .slice(entry.start, entry.end)
      .split("\n")[0]
      .normalize("NFKC")
      .trim()
      .replace(
        /^(?:#{1,6}\s*|[一二三四五六七八九十]{1,3}[、.]\s*|\([一二三四五六七八九十]{1,3}\)\s*)/gu,
        "",
      );
    const labelled = line.match(
      /^(?:业务分类|类别|分类[一二三四五六七八九十\d]*|意图|category|intent)\s*:\s*([^。;；:\n]{1,80})/iu,
    );
    const numberedName =
      entry.code && entry.name.match(/^([^:：]{1,80})[:：]\s*\S/u)?.[1];
    const categoryName =
      labelled?.[1]?.trim() ??
      numberedName?.trim() ??
      (entry.listOrdinal ? entry.name : undefined);
    return {
      ...(entry.code ? { code: entry.code } : {}),
      ...(entry.listOrdinal ? { listOrdinal: true as const } : {}),
      ...(categoryName ? { categoryName } : {}),
      name: entry.name.replace(/[;；。]+$/u, ""),
      start: entry.start,
      end: entry.end,
      text: body.slice(entry.start, entry.end).trim(),
      fragments: ranges
        .filter(
          (range) =>
            (range.end > entry.start && range.start < entry.end) ||
            (entry.parent !== undefined &&
              range.start <= entry.parent &&
              range.end > entry.parent),
        )
        .map((range) => range.index),
    };
  });
  return { sections, malformedTable };
}

export function isCategorySection(section: BackgroundSection) {
  return !/^(?:背景|业务|测试|文档|资料)?(?:说明|概述|分类|类别|要求|规则|信息|内容|定义|目录|总则)$/u.test(
    section.categoryName ?? section.name,
  );
}

export function sectionAliases(section: BackgroundSection, legacy = false) {
  if (section.categoryName && !legacy)
    return [
      section.categoryName,
      ...(section.code && !section.listOrdinal
        ? [section.code, section.code + " " + section.categoryName]
        : []),
    ];
  // Keep a literal list-marked alias for already-saved definitions.
  const originalName = section.text.split(/[:：\n]/u)[0].trim();
  return [
    ...(section.categoryName ? [section.categoryName] : []),
    section.name,
    ...(originalName !== section.name &&
    originalName.replace(/^(?:[-*+]\s+|\d+[.)、]\s+)/u, "") === section.name
      ? [originalName]
      : []),
    ...(section.code ? [section.code, section.code + " " + section.name] : []),
  ];
}

export function matchingSections(
  sections: BackgroundSection[],
  value: string,
  legacy = false,
) {
  const query = normalizedExcerpt(value);
  return sections.filter(
    (section) =>
      (legacy || isCategorySection(section)) &&
      sectionAliases(section, legacy).some(
        (alias) => normalizedExcerpt(alias) === query,
      ),
  );
}

/** Undefined retains the existing literal-prose path when there is no indexed entry. */
export function matchesSectionDefinition(
  fragments: BackgroundFragment[],
  selected: number[],
  value: string,
  quote: string,
  legacy = false,
): boolean | undefined {
  const index = backgroundSections(fragments);
  const matches = matchingSections(index.sections, value, legacy);
  if (
    !legacy &&
    index.sections.some(
      (s) =>
        !isCategorySection(s) &&
        normalizedExcerpt(s.name) === normalizedExcerpt(value),
    )
  )
    return false;
  if (index.malformedTable) return false;
  if (!matches.length) return undefined;
  if (matches.length !== 1) return false;
  const section = matches[0];
  if (!section.fragments.every((part) => selected.includes(part))) return false;
  const text = normalizedExcerpt(quote);
  if (!text || (section.code && text === normalizedExcerpt(section.code)))
    return false;
  return normalizedExcerpt(section.text).includes(text);
}
