import hljs from "highlight.js";
import { marked } from "marked";
import "highlight.js/styles/monokai.css";

// Configure marked with syntax highlighting for fenced code blocks
marked.setOptions({
  gfm: true,
  breaks: true,
});

// Custom renderer for code blocks with syntax highlighting
const renderer = new marked.Renderer();
renderer.code = ({ text, lang }) => {
  if (lang && hljs.getLanguage(lang)) {
    const highlighted = hljs.highlight(text, { language: lang }).value;
    return `<pre><code class="hljs language-${lang}">${highlighted}</code></pre>`;
  }
  // Fallback: auto-detect or plain
  const highlighted = hljs.highlightAuto(text).value;
  return `<pre><code class="hljs">${highlighted}</code></pre>`;
};

marked.use({ renderer });

// Unescape quotes that marked escapes unnecessarily
function unescapeQuotes(html: string): string {
  return html.replace(/&#39;/g, "'").replace(/&quot;/g, '"');
}

// GitHub reference patterns
const GITHUB_USER_MENTION = /@([a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)/g;
const GITHUB_ISSUE_REF = /#(\d+)/g;
const GITHUB_CROSS_REPO_REF = /([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+)#(\d+)/g;

interface GitHubContext {
  owner: string;
  repo: string;
}

// Process GitHub-specific references in text
function processGitHubRefs(html: string, ctx: GitHubContext | null): string {
  const baseUrl = "https://github.com";

  // Process cross-repo references first (before simple #123 refs)
  html = html.replace(GITHUB_CROSS_REPO_REF, (match, repo, number) => {
    return `<a href="${baseUrl}/${repo}/issues/${number}" target="_blank" rel="noopener noreferrer" class="text-accent hover:underline">${match}</a>`;
  });

  // Process @mentions
  html = html.replace(GITHUB_USER_MENTION, (_match, username) => {
    // Don't process if already inside a link
    return `<a href="${baseUrl}/${username}" target="_blank" rel="noopener noreferrer" class="text-accent hover:underline">@${username}</a>`;
  });

  // Process #123 issue refs (only with context)
  if (ctx) {
    html = html.replace(GITHUB_ISSUE_REF, (_match, number) => {
      return `<a href="${baseUrl}/${ctx.owner}/${ctx.repo}/issues/${number}" target="_blank" rel="noopener noreferrer" class="text-accent hover:underline">#${number}</a>`;
    });

    // Process commit SHAs (only with context)
    // Negative lookbehind to avoid matching hex inside HTML entities like &#39;
    const COMMIT_SHA_SAFE = /(?<!&#)\b([a-f0-9]{7,40})\b/g;
    html = html.replace(COMMIT_SHA_SAFE, (match, sha) => {
      // Only process if it looks like a commit SHA (hex chars only, reasonable length)
      if (sha.length >= 7 && sha.length <= 40) {
        const shortSha = sha.slice(0, 7);
        return `<a href="${baseUrl}/${ctx.owner}/${ctx.repo}/commit/${sha}" target="_blank" rel="noopener noreferrer" class="font-mono text-accent hover:underline">${shortSha}</a>`;
      }
      return match;
    });
  }

  return html;
}

// Parse markdown with GitHub extensions
export function parseMarkdown(text: string, context?: GitHubContext | null): string {
  // First parse with marked
  let html = marked.parse(text, { async: false }) as string;

  // Unescape quotes
  html = unescapeQuotes(html);

  // Then process GitHub-specific references
  html = processGitHubRefs(html, context ?? null);

  return html;
}

// Re-export marked for cases where we don't need GitHub extensions
export { marked };
