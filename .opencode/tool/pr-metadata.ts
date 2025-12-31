import { tool } from "@opencode-ai/plugin";

const API_BASE = "http://localhost:3001";

export default tool({
  description:
    "Get PR metadata including title, description, and list of changed files with line counts (+added -removed). Use this to understand the scope of the PR before diving into specific files.",
  args: {},
  async execute() {
    console.log(`[pr-metadata] Fetching PR metadata`);

    try {
      const response = await fetch(`${API_BASE}/api/pr/metadata`);
      const data = await response.json();

      if (!response.ok) {
        console.log(`[pr-metadata] Error response:`, data);
        return `Error: ${data.error}`;
      }

      console.log(`[pr-metadata] Successfully got metadata`);
      return data.metadata;
    } catch (error) {
      console.log(`[pr-metadata] Fetch error:`, error);
      return `Error fetching metadata: ${error}`;
    }
  },
});
