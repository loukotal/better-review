import hljs from "highlight.js";
import { marked } from "marked";
import "highlight.js/styles/monokai.css";

// Configure marked with syntax highlighting for fenced code blocks
marked.setOptions({
  gfm: true,
  breaks: true,
});

// Media URL patterns - GitHub user-attachments can be images OR videos
const GITHUB_ASSET_URL = /github\.com\/user-attachments\/assets\//;
const GITHUB_ASSET_ID_PATTERN = /github\.com\/user-attachments\/assets\/([a-f0-9-]+)/;
const GITHUBUSERCONTENT_URL = /githubusercontent\.com\//;

// Known image extensions
const IMAGE_EXTENSIONS = /\.(png|jpg|jpeg|gif|webp|svg|bmp|ico)(\?|$)/i;
// Known video extensions
const VIDEO_EXTENSIONS = /\.(mp4|webm|mov|avi|mkv|m4v|ogv)(\?|$)/i;

// Convert GitHub asset URL to use our proxy (to bypass CORS/ORB)
function proxyGitHubAssetUrl(url: string): string {
  const match = url.match(GITHUB_ASSET_ID_PATTERN);
  if (match) {
    return `/api/github-asset/${match[1]}`;
  }
  return url;
}

// Custom renderer for code blocks with syntax highlighting and media handling
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

renderer.image = ({ href, title, text }) => {
  const titleAttr = title ? ` title="${title}"` : "";
  const baseClasses = "max-w-full h-auto rounded border border-border my-2";

  // Use proxy for GitHub assets to bypass CORS/ORB
  const srcUrl = proxyGitHubAssetUrl(href);

  // Check if this is actually a video
  if (VIDEO_EXTENSIONS.test(href)) {
    return `<video src="${srcUrl}" controls class="${baseClasses}" style="max-height: 400px;"${titleAttr}><a href="${href}" target="_blank" rel="noopener noreferrer">${text || "View video"}</a></video>`;
  }

  // Check if it's a GitHub asset (could be image or video)
  if (GITHUB_ASSET_URL.test(href) && !IMAGE_EXTENSIONS.test(href)) {
    // Unknown type - use smart detection with fallback link
    // Order: try video -> try image -> show link
    return `<span class="media-container block"><video src="${srcUrl}" controls class="${baseClasses}" style="max-height: 400px; display: none;" onloadedmetadata="this.style.display='block'" onerror="this.style.display='none'; this.nextElementSibling.style.display='block'"></video><img src="${srcUrl}" alt="${text || "media"}"${titleAttr} class="${baseClasses}" style="display: none;" onload="this.style.display='block'" onerror="this.style.display='none'; this.nextElementSibling.style.display='inline-flex'" /><a href="${href}" target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-2 px-3 py-2 text-sm text-accent hover:underline bg-bg-elevated border border-border rounded my-2" style="display: none;"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"/></svg>View attachment</a></span>`;
  }

  return `<img src="${srcUrl}" alt="${text}"${titleAttr} class="${baseClasses}" loading="lazy" />`;
};

renderer.link = ({ href, title, text }) => {
  const titleAttr = title ? ` title="${title}"` : "";
  const isExternal = /^https?:\/\//i.test(href);
  const targetAttrs = isExternal ? ' target="_blank" rel="noopener noreferrer"' : "";
  return `<a href="${href}"${titleAttr}${targetAttrs}>${text}</a>`;
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

// Process GitHub-specific references in text content only (not inside HTML tags or link text)
function processGitHubRefs(html: string, ctx: GitHubContext | null): string {
  const baseUrl = "https://github.com";

  // Split HTML into tags and text content to avoid processing URLs in attributes
  // This regex matches HTML tags (including their attributes)
  const parts = html.split(/(<[^>]+>)/);

  // Track nesting depth inside <a> tags so we don't inject links inside links
  let insideAnchor = 0;

  const processedParts = parts.map((part) => {
    // If this is an HTML tag, track <a> nesting but don't modify it
    if (part.startsWith("<")) {
      if (/^<a[\s>]/i.test(part)) {
        insideAnchor++;
      } else if (/^<\/a>/i.test(part)) {
        insideAnchor = Math.max(0, insideAnchor - 1);
      }
      return part;
    }

    // Skip text content that's inside an <a> tag (link text) to avoid nested links
    if (insideAnchor > 0) {
      return part;
    }

    // This is text content outside links, process GitHub refs
    let text = part;

    // Process cross-repo references first (before simple #123 refs)
    text = text.replace(GITHUB_CROSS_REPO_REF, (match, repo, number) => {
      return `<a href="${baseUrl}/${repo}/issues/${number}" target="_blank" rel="noopener noreferrer" class="text-accent hover:underline">${match}</a>`;
    });

    // Process @mentions
    text = text.replace(GITHUB_USER_MENTION, (_match, username) => {
      return `<a href="${baseUrl}/${username}" target="_blank" rel="noopener noreferrer" class="text-accent hover:underline">@${username}</a>`;
    });

    // Process #123 issue refs (only with context)
    if (ctx) {
      text = text.replace(GITHUB_ISSUE_REF, (_match, number) => {
        return `<a href="${baseUrl}/${ctx.owner}/${ctx.repo}/issues/${number}" target="_blank" rel="noopener noreferrer" class="text-accent hover:underline">#${number}</a>`;
      });

      // Process commit SHAs (only with context)
      // Negative lookbehind to avoid matching hex inside HTML entities like &#39;
      const COMMIT_SHA_SAFE = /(?<!&#)\b([a-f0-9]{7,40})\b/g;
      text = text.replace(COMMIT_SHA_SAFE, (match, sha) => {
        // Only process if it looks like a commit SHA (hex chars only, reasonable length)
        if (sha.length >= 7 && sha.length <= 40) {
          const shortSha = sha.slice(0, 7);
          return `<a href="${baseUrl}/${ctx.owner}/${ctx.repo}/commit/${sha}" target="_blank" rel="noopener noreferrer" class="font-mono text-accent hover:underline">${shortSha}</a>`;
        }
        return match;
      });
    }

    return text;
  });

  return processedParts.join("");
}

function getMediaType(url: string): "image" | "video" | "unknown" {
  if (IMAGE_EXTENSIONS.test(url)) return "image";
  if (VIDEO_EXTENSIONS.test(url)) return "video";
  // GitHub assets without extension - we can't know, so return unknown
  if (GITHUB_ASSET_URL.test(url) || GITHUBUSERCONTENT_URL.test(url)) return "unknown";
  return "image"; // Default to image for other URLs with image-like patterns
}

function isMediaUrl(url: string): boolean {
  return (
    GITHUB_ASSET_URL.test(url) ||
    GITHUBUSERCONTENT_URL.test(url) ||
    IMAGE_EXTENSIONS.test(url) ||
    VIDEO_EXTENSIONS.test(url)
  );
}

// Create media element HTML - uses a smart approach for unknown types
function createMediaElement(url: string): string {
  const mediaType = getMediaType(url);
  const baseClasses = "max-w-full h-auto rounded border border-border my-2";

  // Use proxy for GitHub assets to bypass CORS/ORB
  const srcUrl = proxyGitHubAssetUrl(url);

  if (mediaType === "video") {
    return `<video src="${srcUrl}" controls class="${baseClasses}" style="max-height: 400px;"><a href="${url}" target="_blank" rel="noopener noreferrer">View video</a></video>`;
  }

  if (mediaType === "image") {
    return `<img src="${srcUrl}" alt="image" class="${baseClasses}" loading="lazy" />`;
  }

  // Unknown type (GitHub assets) - try video, then image, then show link fallback
  return `<span class="media-container block"><video src="${srcUrl}" controls class="${baseClasses}" style="max-height: 400px; display: none;" onloadedmetadata="this.style.display='block'" onerror="this.style.display='none'; this.nextElementSibling.style.display='block'"></video><img src="${srcUrl}" alt="media" class="${baseClasses}" style="display: none;" onload="this.style.display='block'" onerror="this.style.display='none'; this.nextElementSibling.style.display='inline-flex'" /><a href="${url}" target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-2 px-3 py-2 text-sm text-accent hover:underline bg-bg-elevated border border-border rounded my-2" style="display: none;"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"/></svg>View attachment</a></span>`;
}

// Convert links that point to media into actual media elements
function convertMediaLinksToMedia(html: string): string {
  // Match <a> tags where href equals the link text (auto-linked URLs) and href is a media URL
  // Pattern: <a href="URL">URL</a> where both URLs are the same
  return html.replace(/<a\s+href="([^"]+)"[^>]*>([^<]+)<\/a>/g, (match, href, text) => {
    // Only convert if the link text matches the href (auto-linked URL) and it's a media URL
    if (href === text && isMediaUrl(href)) {
      return createMediaElement(href);
    }
    return match;
  });
}

// Parse markdown with GitHub extensions
export function parseMarkdown(text: string, context?: GitHubContext | null): string {
  // First parse with marked
  let html = marked.parse(text, { async: false }) as string;

  // Unescape quotes
  html = unescapeQuotes(html);

  // Convert auto-linked media URLs to actual media elements (images/videos)
  html = convertMediaLinksToMedia(html);

  // Then process GitHub-specific references
  html = processGitHubRefs(html, context ?? null);

  return html;
}

// Re-export marked for cases where we don't need GitHub extensions
export { marked };
