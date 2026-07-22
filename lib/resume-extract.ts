import { RESUME_MAX_CHARS } from "@/lib/interview-schema";

// Client-side PDF text extraction — privacy is the pitch: the PDF is parsed
// entirely in this browser tab (pdfjs-dist, loaded on demand). The file never
// leaves the device; only the extracted TEXT flows into the resume field.
// pdfjs is dynamically imported so it stays out of the initial bundle and out
// of every server/test environment.

export type ResumeExtractCode = "too-large" | "encrypted" | "no-text" | "unreadable";

export class ResumeExtractError extends Error {
  readonly code: ResumeExtractCode;
  constructor(code: ResumeExtractCode, message: string) {
    super(message);
    this.name = "ResumeExtractError";
    this.code = code;
  }
}

export const MAX_PDF_BYTES = 10 * 1024 * 1024; // 10MB cap — resumes are small; bigger means scans

/** One pdfjs text item — only the fields we read, so helpers stay pure and testable. */
export type PdfTextItem = { str: string; hasEOL?: boolean };

/** Join one page's text items: pdfjs EOL markers become newlines, whitespace runs collapse. */
export function collapsePageText(items: PdfTextItem[]): string {
  let out = "";
  for (const item of items) {
    out += item.str;
    out += item.hasEOL ? "\n" : " ";
  }
  return out
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .trim();
}

/** Assemble page texts into the final resume string, trimmed to RESUME_MAX_CHARS.
 * Throws no-text when nothing extractable came out (scanned/image-only PDF). */
export function finalizeResumeText(pages: string[]): string {
  const text = pages
    .map((p) => p.trim())
    .filter(Boolean)
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (text.length < 40) {
    throw new ResumeExtractError(
      "no-text",
      "No selectable text in that PDF — it looks scanned. Paste the resume text instead.",
    );
  }
  return text.slice(0, RESUME_MAX_CHARS);
}

/** Extract all text from a PDF resume, in the browser. Throws ResumeExtractError. */
export async function extractPdfText(file: File): Promise<string> {
  if (file.size > MAX_PDF_BYTES) {
    throw new ResumeExtractError("too-large", "That PDF is over 10MB — export a smaller one or paste the text.");
  }
  const pdfjs = await import("pdfjs-dist");
  // Webpack emits the worker as an asset via new URL(..., import.meta.url).
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    "pdfjs-dist/build/pdf.worker.min.mjs",
    import.meta.url,
  ).toString();

  const data = new Uint8Array(await file.arrayBuffer());
  const task = pdfjs.getDocument({ data });
  let doc: Awaited<typeof task.promise>;
  try {
    doc = await task.promise;
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    if (name === "PasswordException") {
      throw new ResumeExtractError("encrypted", "That PDF is password-protected — unlock it or paste the text.");
    }
    throw new ResumeExtractError("unreadable", "Couldn't read that file as a PDF — paste the resume text instead.");
  }
  try {
    const pages: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const items: PdfTextItem[] = [];
      for (const it of content.items) {
        // TextMarkedContent entries carry no text — keep only real items.
        if ("str" in it && typeof it.str === "string") items.push({ str: it.str, hasEOL: it.hasEOL });
      }
      pages.push(collapsePageText(items));
    }
    return finalizeResumeText(pages);
  } finally {
    void task.destroy().catch(() => {});
  }
}
