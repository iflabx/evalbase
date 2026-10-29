import { zipSync } from "fflate";
import { request, soloVersionDownloadUrl } from "./workspace";
/** Same authorized CSV endpoints as the version page; no private object URLs enter model output. */
export async function downloadVersionBundle(
  projectId: string,
  testSetId: string,
  version: { id: string; label: string },
) {
  const files = await Promise.all(
    (["data.csv", "provenance.csv"] as const).map(async (file) => {
      const response = await request<Response>(
        soloVersionDownloadUrl(projectId, testSetId, version.id, file),
        undefined,
        "response",
      );
      return [file, new Uint8Array(await response.arrayBuffer())] as const;
    }),
  );
  const archive = zipSync(Object.fromEntries(files), { level: 0 }),
    url = URL.createObjectURL(
      new Blob([archive.buffer as ArrayBuffer], { type: "application/zip" }),
    );
  const link = document.createElement("a");
  link.href = url;
  link.download = `evalbase-${version.label}-data-and-provenance.zip`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
