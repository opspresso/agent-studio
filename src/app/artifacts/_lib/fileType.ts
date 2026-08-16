export type ArtifactFileType = "pdf" | "docx" | "pptx" | "hwpx" | "generic";

const MIME_TYPES: Record<string, ArtifactFileType> = {
  "application/pdf": "pdf",
  "application/msword": "docx",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-powerpoint": "pptx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/haansofthwpx": "hwpx",
  "application/vnd.hancom.hwpx": "hwpx",
  "application/x-hwp": "hwpx",
};

export function artifactFileType(
  mimeType: string,
  filename?: string,
  key?: string,
): ArtifactFileType {
  const byMime = MIME_TYPES[mimeType.toLowerCase()];
  if (byMime) {
    return byMime;
  }
  const extension = (filename ?? key)?.split(".").at(-1)?.toLowerCase();
  return extension === "pdf" || extension === "docx" || extension === "pptx" || extension === "hwpx"
    ? extension
    : "generic";
}
