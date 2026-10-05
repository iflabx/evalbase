import { AssistantError } from "./store.js";
import { Worker } from "node:worker_threads";

export const BACKGROUND_LIMITS = {
  files: 5,
  bytes: 10 * 1024 * 1024,
  characters: 500000,
  pages: 200,
  lines: 10000,
  fragmentCharacters: 2000,
} as const;
export type BackgroundFragment = {
  index: number;
  page?: number;
  startLine?: number;
  endLine?: number;
  text: string;
};
export type ExtractedBackground = {
  format: "txt" | "md" | "pdf";
  extractorVersion: string;
  units: number;
  characters: number;
  fragments: BackgroundFragment[];
};

// A fixed program parses untrusted PDFs outside the Web event loop. It never evaluates document code.
const pdfProgram = `
const { parentPort, workerData } = require("node:worker_threads");
(async () => {
  const { getDocumentProxy } = await import(workerData.module);
  const { readFile } = await import("node:fs/promises");
  const { limits } = workerData;
  // Serverless PDF.js fetches HTTP URLs. This worker-only adapter serves package resources,
  // including Chinese character maps, without opening a network connection.
  const resourceOrigin = "https://evalbase-background-resources.invalid";
  globalThis.fetch = async (input) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.origin !== resourceOrigin || url.search || url.hash || !/^\\/(cmaps\\/[A-Za-z0-9_-]+\\.bcmap|standard_fonts\\/[A-Za-z0-9_-]+\\.(ttf|pfb))$/.test(url.pathname))
      throw new Error("External PDF resource blocked");
    return new Response(new Uint8Array(await readFile(new URL(url.pathname.slice(1), workerData.resources))));
  };
  let pdf;
  try {
    pdf = await getDocumentProxy(new Uint8Array(workerData.bytes), {
      isEvalSupported: false, maxImageSize: 0, useSystemFonts: false, disableAutoFetch: true,
      useWorkerFetch: true, useWasm: false,
      cMapUrl: resourceOrigin + "/cmaps/", cMapPacked: true,
      standardFontDataUrl: resourceOrigin + "/standard_fonts/"
    });
    if (pdf.numPages > limits.pages) throw new Error("assistant_document_capacity");
    const fragments = [];
    let characters = 0;
    for (let page = 1; page <= pdf.numPages; page++) {
      const contents = await (await pdf.getPage(page)).getTextContent();
      const text = contents.items.filter(item => typeof item.str === "string")
        .map(item => item.str + (item.hasEOL ? "\\n" : "")).join("").trim();
      characters += text.length;
      if (characters > limits.characters) throw new Error("assistant_document_capacity");
      for (let offset = 0; offset < text.length; offset += limits.fragmentCharacters)
        fragments.push({ index: fragments.length + 1, page, text: text.slice(offset, offset + limits.fragmentCharacters) });
    }
    if (!characters) throw new Error("assistant_document_no_text");
    parentPort.postMessage({ result: { format: "pdf", extractorVersion: "unpdf-1.8.1/background-pdf-v1", units: pdf.numPages, characters, fragments } });
  } catch (error) {
    parentPort.postMessage({ error: ["assistant_document_capacity", "assistant_document_no_text"].includes(error.message) ? error.message : "assistant_document_parse" });
  } finally { await pdf?.destroy(); }
})().catch(() => parentPort.postMessage({ error: "assistant_document_parse" }));
`;

async function extractPdf(bytes: Uint8Array): Promise<ExtractedBackground> {
  const worker = new Worker(pdfProgram, {
    eval: true,
    workerData: {
      module: import.meta.resolve("unpdf"),
      resources: import.meta.resolve("pdfjs-dist/package.json"),
      bytes,
      limits: BACKGROUND_LIMITS,
    },
    resourceLimits: { maxOldGenerationSizeMb: 128, stackSizeMb: 4 },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<ExtractedBackground>((resolve, reject) => {
      worker.once("message", (message) =>
        message.result
          ? resolve(message.result)
          : reject(
              new AssistantError(
                message.error === "assistant_document_capacity" ? 413 : 422,
                message.error,
              ),
            ),
      );
      worker.once("error", () =>
        reject(new AssistantError(422, "assistant_document_parse")),
      );
      worker.once("exit", () =>
        reject(new AssistantError(422, "assistant_document_parse")),
      );
      timer = setTimeout(
        () => reject(new AssistantError(422, "assistant_document_timeout")),
        30000,
      );
      timer.unref();
    });
  } finally {
    clearTimeout(timer);
    await worker.terminate();
  }
}

export async function extractBackground(
  fileName: string,
  bytes: Uint8Array,
): Promise<ExtractedBackground> {
  if (
    !fileName ||
    fileName.length > 200 ||
    fileName.includes("/") ||
    fileName.includes("\\") ||
    [...fileName].some((character) => character.charCodeAt(0) < 32)
  )
    throw new AssistantError(422, "assistant_document_name");
  const format = fileName.split(".").at(-1)?.toLowerCase();
  if (format !== "txt" && format !== "md" && format !== "pdf")
    throw new AssistantError(422, "assistant_document_format");
  if (!bytes.byteLength || bytes.byteLength > BACKGROUND_LIMITS.bytes)
    throw new AssistantError(413, "assistant_document_capacity");
  if (format === "pdf") return extractPdf(bytes);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true })
      .decode(bytes)
      .replace(/\r\n?/gu, "\n");
  } catch {
    throw new AssistantError(422, "assistant_document_encoding");
  }
  if (text.includes("\u0000"))
    throw new AssistantError(422, "assistant_document_encoding");
  if (!text.trim()) throw new AssistantError(422, "assistant_document_no_text");
  const lines = text.split("\n");
  if (
    text.length > BACKGROUND_LIMITS.characters ||
    lines.length > BACKGROUND_LIMITS.lines
  )
    throw new AssistantError(413, "assistant_document_capacity");
  const fragments: BackgroundFragment[] = [];
  for (let start = 0; start < lines.length; start += 40) {
    const block = lines.slice(start, start + 40).join("\n");
    for (
      let offset = 0;
      offset < Math.max(1, block.length);
      offset += BACKGROUND_LIMITS.fragmentCharacters
    )
      fragments.push({
        index: fragments.length + 1,
        startLine: start + 1,
        endLine: Math.min(start + 40, lines.length),
        text: block.slice(
          offset,
          offset + BACKGROUND_LIMITS.fragmentCharacters,
        ),
      });
  }
  return {
    format,
    extractorVersion: "background-text-v1",
    units: lines.length,
    characters: text.length,
    fragments,
  };
}
