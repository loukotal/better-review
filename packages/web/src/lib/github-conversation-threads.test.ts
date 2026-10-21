import assert from "node:assert/strict";
import { test } from "node:test";

import {
  githubConversationReplyBody,
  groupGithubConversation,
} from "./github-conversation-threads";

const author = (comment: { login?: string }) => comment.login;

test("nested quoted issue replies group chronologically without quoting ancestors", () => {
  const comments = [
    { login: "root", body: "Root\nsecond line" },
    { login: "reply", body: "> Root\n> second line\n\n@root First reply" },
    { login: "third", body: "> First reply\n\n@reply Second reply" },
  ];
  assert.deepEqual(groupGithubConversation(comments, author), [
    { root: comments[0], replies: comments.slice(1) },
  ]);
  assert.equal(githubConversationReplyBody(comments[1]!.body), "First reply");
  assert.equal(githubConversationReplyBody(comments[2]!.body), "Second reply");
});

test("ordinary Markdown quotes and mentions retain their body", () => {
  for (const body of [
    "> Quoted code\n\nExplanation",
    "@author hello",
    "> Quoted code",
    "Before\n> quote\n\n@author hello",
  ])
    assert.equal(githubConversationReplyBody(body), body);
});

test("unmatched or edited quote targets remain visible as separate comments", () => {
  const comments = [
    { login: "author", body: "Edited root" },
    { login: "reply", body: "> Original root\n\n@author Reply" },
  ];
  assert.deepEqual(
    groupGithubConversation(comments, author),
    comments.map((root) => ({ root, replies: [] })),
  );
});

test("three-line quotes match longer targets and preserve reply Markdown", () => {
  const comments = [
    { login: "author", body: "One\nTwo\nThree\nFour" },
    { login: "reply", body: "> One\n> Two\n> Three\n\n@author Reply\n\n> retained quote" },
  ];
  assert.equal(groupGithubConversation(comments, author).length, 1);
  assert.equal(githubConversationReplyBody(comments[1]!.body), "Reply\n\n> retained quote");
});

test("quotes of hidden wire context stay standalone rather than guessing a target", () => {
  const comments = [
    { login: "author", body: "Root" },
    { login: "author", body: "> Root\n\n@author First reply" },
    { login: "author", body: "> > Root\n> \n> @author First reply\n\n@author Second reply" },
  ];
  assert.equal(groupGithubConversation(comments, author).length, 2);
  assert.equal(githubConversationReplyBody(comments[2]!.body), "Second reply");
});

test("same text by different authors matches the mentioned author case-insensitively", () => {
  const comments = [
    { login: "Alice", body: "Looks good" },
    { login: "Bob", body: "Looks good" },
    { login: "reviewer", body: "> Looks good\n\n@aLiCe Thanks" },
  ];
  assert.deepEqual(groupGithubConversation(comments, author), [
    { root: comments[0], replies: [comments[2]] },
    { root: comments[1], replies: [] },
  ]);
});

test("same-author identical bodies are ambiguous, never latest-match wins", () => {
  const comments = [
    { login: "alice", body: "Looks good" },
    { login: "Alice", body: "Looks good" },
    { login: "reviewer", body: "> Looks good\n\n@alice Thanks" },
  ];
  assert.deepEqual(
    groupGithubConversation(comments, author),
    comments.map((root) => ({ root, replies: [] })),
  );
});

test("missing mention, unknown author, and arbitrary body prefixes do not imply relationships", () => {
  for (const comments of [
    [{ login: "alice", body: "Looks good" }, { body: "> Looks good\n\nThanks" }],
    [{ body: "Looks good" }, { body: "> Looks good\n\n@alice Thanks" }],
    [{ login: "alice", body: "Looks good indeed" }, { body: "> Looks good\n\n@alice Thanks" }],
    [{ login: "alice", body: "One\nTwo\nThree\nFour" }, { body: "> One\n> Two\n\n@alice Thanks" }],
  ])
    assert.deepEqual(
      groupGithubConversation(comments, author),
      comments.map((root) => ({ root, replies: [] })),
    );
});

test("legacy explicit three-line truncation remains supported", () => {
  const comments = [
    { login: "alice", body: "One\nTwo\nThree\nFour" },
    { body: "> One\n> Two\n> Three\n> ...\n\n@alice Thanks" },
  ];
  assert.equal(groupGithubConversation(comments, author).length, 1);
});
