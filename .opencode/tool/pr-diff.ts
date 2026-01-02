import { tool } from "@opencode-ai/plugin";

const API_BASE = `http://localhost:${process.env.API_PORT ?? 3001}`;

export default tool({
  description:
    "Get the diff for a specific file in the PR being reviewed. Use this to see what changed in a file. Only use files from the list of changed files provided in the context. You can optionally specify a line range to get only part of the diff. Specify line range for large diffs.",
  args: {
    file: tool.schema
      .string()
      .describe(
        "The file path to get the diff for (must be from the list of changed files)",
      ),
    startLine: tool.schema
      .number()
      .optional()
      .describe(
        "Optional: Start line number to filter the diff (shows hunks containing this line and after)",
      ),
    endLine: tool.schema
      .number()
      .optional()
      .describe(
        "Optional: End line number to filter the diff (shows hunks up to and containing this line)",
      ),
  },
  async execute(args) {
    console.log(
      `[pr-diff] Called with file: ${args.file}, startLine: ${args.startLine}, endLine: ${args.endLine}`,
    );

    try {
      let url = `${API_BASE}/api/pr/file-diff?file=${encodeURIComponent(args.file)}`;
      if (args.startLine !== undefined) {
        url += `&startLine=${args.startLine}`;
      }
      if (args.endLine !== undefined) {
        url += `&endLine=${args.endLine}`;
      }

      const response = await fetch(url);
      const data = await response.json();

      if (!response.ok) {
        console.log(`[pr-diff] Error response:`, data);

        if (data.availableFiles) {
          return `Error: ${data.error}\n\nAvailable files:\n${data.availableFiles.map((f: string) => `- ${f}`).join("\n")}`;
        }

        return `Error: ${data.error}`;
      }

      console.log(
        `[pr-diff] Successfully got diff for ${args.file} (${data.diff.length} chars)`,
      );
      return data.diff;
    } catch (error) {
      console.log(`[pr-diff] Fetch error:`, error);
      return `Error fetching diff: ${error}`;
    }
  },
});
