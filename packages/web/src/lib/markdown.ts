import { marked, type Renderer, type Tokens } from "marked";

import { extractGitHubAssetId, toGitHubAssetProxyPath } from "@better-review/shared/github-asset";

// Configure marked with syntax highlighting for fenced code blocks
marked.setOptions({
  gfm: true,
  breaks: true,
});

// Media URL patterns - GitHub user-attachments can be images OR videos
const GITHUB_ASSET_URL = /github\.com\/user-attachments\/assets\//;
const GITHUBUSERCONTENT_URL = /githubusercontent\.com\//;

// Known image extensions
const IMAGE_EXTENSIONS = /\.(png|jpg|jpeg|gif|webp|svg|bmp|ico)(\?|$)/i;
// Known video extensions
const VIDEO_EXTENSIONS = /\.(mp4|webm|mov|avi|mkv|m4v|ogv)(\?|$)/i;

// Convert GitHub asset URL to use our proxy (to bypass CORS/ORB)
function proxyGitHubAssetUrl(url: string): string {
  const assetId = extractGitHubAssetId(url);
  if (assetId) return toGitHubAssetProxyPath(assetId) ?? url;
  return url;
}

function isSafeUrl(url: string): boolean {
  const trimmed = url.trim();
  if (!trimmed) return false;

  if (
    trimmed.startsWith("#") ||
    trimmed.startsWith("/") ||
    trimmed.startsWith("./") ||
    trimmed.startsWith("../")
  ) {
    return true;
  }

  try {
    const parsed = new URL(trimmed);
    return (
      parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.protocol === "mailto:"
    );
  } catch {
    return false;
  }
}

function getSafeUrl(url: string): string | null {
  return isSafeUrl(url) ? url : null;
}

export function escapeHtmlText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function normalizeMalformedInlineCode(text: string): string {
  return text.replace(
    /(^|\n)([ \t]*[-*•]\s*)?`\s*\n([^\n`][^\n]*?)\n[ \t]*`(?=\n|$)/g,
    (_match, prefix: string, bullet: string | undefined, content: string) => {
      const trimmed = content.trim();
      return `${prefix}${bullet ?? ""}\`${trimmed}\``;
    },
  );
}

function escapeHtmlAttribute(value: string): string {
  return escapeHtmlText(value).replace(/"/g, "&quot;");
}

function getLanguageClass(lang: string | undefined): string {
  const normalized = (lang ?? "text").toLowerCase().replace(/[^a-z0-9-]/g, "");
  return normalized.length > 0 ? ` language-${normalized}` : "";
}

function renderSafeImage({ href, title, text }: Tokens.Image): string {
  const safeHref = getSafeUrl(href);
  if (!safeHref) {
    return `<span>${escapeHtmlText(text || href)}</span>`;
  }

  const titleAttr = title ? ` title="${escapeHtmlAttribute(title)}"` : "";
  const baseClasses = "max-w-full h-auto rounded border border-border my-2";
  const escapedText = escapeHtmlAttribute(text || "image");

  // Use proxy for GitHub assets to bypass CORS/ORB
  const srcUrl = proxyGitHubAssetUrl(safeHref);
  const escapedSrcUrl = escapeHtmlAttribute(srcUrl);

  // Check if this is actually a video
  if (VIDEO_EXTENSIONS.test(safeHref)) {
    return `<video src="${escapedSrcUrl}" controls class="${baseClasses} max-h-[400px]"${titleAttr}><a href="${escapedSrcUrl}" target="_blank" rel="noopener noreferrer">${text || "View video"}</a></video>`;
  }

  // Unknown GitHub assets are rendered as links until we know the media type safely.
  if (GITHUB_ASSET_URL.test(safeHref) && !IMAGE_EXTENSIONS.test(safeHref)) {
    return `<a href="${escapedSrcUrl}" target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-2 px-3 py-2 text-sm text-accent hover:underline bg-bg-elevated border border-border rounded my-2">View attachment</a>`;
  }

  return `<img src="${escapedSrcUrl}" alt="${escapedText}"${titleAttr} class="${baseClasses}" loading="lazy" />`;
}

function renderSafeLink({ href, title, text }: Tokens.Link): string {
  const safeHref = getSafeUrl(href);
  if (!safeHref) return text;

  const escapedHref = escapeHtmlAttribute(safeHref);
  const titleAttr = title ? ` title="${escapeHtmlAttribute(title)}"` : "";
  const isExternal = /^https?:\/\//i.test(safeHref);
  const targetAttrs = isExternal ? ' target="_blank" rel="noopener noreferrer"' : "";
  return `<a href="${escapedHref}"${titleAttr}${targetAttrs}>${text}</a>`;
}

function renderSafeHtml(token: Tokens.HTML | Tokens.Tag): string {
  return escapeHtmlText(token.text);
}

export function applySafeMarkdownRenderer(renderer: Renderer): Renderer {
  renderer.link = renderSafeLink;
  renderer.image = renderSafeImage;
  renderer.html = renderSafeHtml;
  return renderer;
}

// Custom renderer for code blocks with safe image/link/html handling
const renderer = applySafeMarkdownRenderer(new marked.Renderer());

renderer.code = ({ text, lang }) => {
  return `<pre><code class="markdown-code-block${getLanguageClass(lang)}">${escapeHtmlText(text)}</code></pre>`;
};

marked.use({ renderer });

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
  const safeUrl = getSafeUrl(url);
  if (!safeUrl) {
    return `<span>${escapeHtmlText(url)}</span>`;
  }

  const mediaType = getMediaType(safeUrl);
  const baseClasses = "max-w-full h-auto rounded border border-border my-2";

  // Use proxy for GitHub assets to bypass CORS/ORB
  const srcUrl = proxyGitHubAssetUrl(safeUrl);

  if (mediaType === "video") {
    return `<video src="${escapeHtmlAttribute(srcUrl)}" controls class="${baseClasses} max-h-[400px]"><a href="${escapeHtmlAttribute(srcUrl)}" target="_blank" rel="noopener noreferrer">View video</a></video>`;
  }

  if (mediaType === "image") {
    return `<img src="${escapeHtmlAttribute(srcUrl)}" alt="image" class="${baseClasses}" loading="lazy" />`;
  }

  return `<a href="${escapeHtmlAttribute(srcUrl)}" target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-2 px-3 py-2 text-sm text-accent hover:underline bg-bg-elevated border border-border rounded my-2">View attachment</a>`;
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
  const normalizedText = normalizeMalformedInlineCode(text);
  // First parse with marked
  let html = marked.parse(normalizedText, { async: false }) as string;

  // Convert auto-linked media URLs to actual media elements (images/videos)
  html = convertMediaLinksToMedia(html);

  // Then process GitHub-specific references
  html = processGitHubRefs(html, context ?? null);

  return html;
}

// Re-export marked for cases where we don't need GitHub extensions
export { marked };
