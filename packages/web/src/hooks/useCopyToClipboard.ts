import { createSignal } from "solid-js";

/**
 * A hook for copying text to clipboard with feedback state.
 * @param resetDelay - How long to show "copied" state (default 2000ms)
 */
export function useCopyToClipboard(resetDelay = 2000) {
  const [copied, setCopied] = createSignal(false);

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), resetDelay);
      return true;
    } catch {
      // Fallback for older browsers
      const textArea = document.createElement("textarea");
      textArea.value = text;
      textArea.style.position = "fixed";
      textArea.style.left = "-9999px";
      document.body.appendChild(textArea);
      textArea.select();
      try {
        document.execCommand("copy");
        setCopied(true);
        setTimeout(() => setCopied(false), resetDelay);
        return true;
      } catch {
        return false;
      } finally {
        document.body.removeChild(textArea);
      }
    }
  };

  return { copied, copy };
}
