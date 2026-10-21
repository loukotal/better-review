/** GitHub issue comments have no reply API. Only our quote + mention convention
 * supplies a presentation relationship; arbitrary Markdown quotes stay intact. */
function quotedReply(body: string) {
  const match = /^(?:>[^\n]*(?:\n|$))+\s*@([\w-]+)[ \t]+([\s\S]*)$/.exec(body.trim());
  if (!match) return;
  const lines: string[] = [];
  for (const line of body.trim().split("\n")) {
    if (!line.startsWith(">")) break;
    lines.push(line.slice(1).replace(/^ /, ""));
  }
  const quote = lines.join("\n").trim();
  return { quote, login: match[1]!.toLowerCase(), body: match[2]!.trim() };
}

export function githubConversationReplyBody(body: string) {
  return quotedReply(body)?.body ?? body;
}

/** Chronological, flat GitHub comments grouped only when an earlier target matches. */
export function groupGithubConversation<T extends { body: string }>(
  comments: T[],
  authorLogin: (comment: T) => string | undefined,
) {
  const threads: { root: T; replies: T[] }[] = [];
  const membership = new Map<T, (typeof threads)[number]>();
  const displayedBodies = new Map<T, string>();
  for (let index = 0; index < comments.length; index++) {
    const comment = comments[index]!;
    const quoted = quotedReply(comment.body);
    const matches = quoted
      ? comments.slice(0, index).filter((candidate) => {
          const login = authorLogin(candidate);
          if (!login || login.toLowerCase() !== quoted.login) return false;
          const text = displayedBodies.get(candidate)!.trim();
          if (text === quoted.quote) return true;
          const lines = text.split("\n");
          if (lines.length <= 3) return false;
          const prefix = lines.slice(0, 3).join("\n");
          return quoted.quote === prefix || quoted.quote === `${prefix}\n...`;
        })
      : [];
    // Quote-based evidence is insufficient when more than one target matches.
    const target = matches.length === 1 ? matches[0] : undefined;
    const thread = target ? membership.get(target) : undefined;
    if (thread) {
      thread.replies.push(comment);
      membership.set(comment, thread);
      displayedBodies.set(comment, quoted!.body);
    } else {
      const next = { root: comment, replies: [] as T[] };
      threads.push(next);
      membership.set(comment, next);
      displayedBodies.set(comment, comment.body);
    }
  }
  return threads;
}
