/** File IDs let tools reopen output; reader-specific download actions belong to the surface. */
export const FILE_DELIVERY_INSTRUCTION =
  "Files are available to File for inspection and editing during this run. " +
  "At the end, the platform stores and attaches only the final version of each generated file with its download action. " +
  "Name the file in plain text; do not repeat its contents in the answer. " +
  "File IDs are only inputs to File tool calls, not links. " +
  "Do not put an ID in a Markdown link or invent attachment:, artifact:, sandbox: or /mnt/data paths. " +
  "Only use a download URL when a tool actually returns that URL.";
