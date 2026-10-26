/** Pixel geometry and one-click contracts, with callbacks only—never runs a review. */
import { createSignal } from "solid-js";
import { render } from "solid-js/web";

import { createAssertions } from "../browser-tests/assertions";
import { ReviewSessionToolbar } from "./ReviewSessionToolbar";

export async function testReviewSessionToolbarInBrowser() {
  const { check, result } = createAssertions(3000);
  const host = document.createElement("div");
  host.style.cssText =
    "position:fixed;top:10px;left:10px;padding:12px;box-sizing:border-box;background:var(--color-bg)";
  document.body.append(host);
  const [disabled, setDisabled] = createSignal(false);
  const [creating, setCreating] = createSignal(false);
  const calls: string[] = [];
  const dispose = render(
    () => (
      <ReviewSessionToolbar
        sessions={[
          { id: "one", headSha: "abc", createdAt: 1, hidden: false },
          { id: "two", headSha: "def", createdAt: 2, hidden: false },
        ]}
        activeSessionId="one"
        currentHeadSha="abc"
        disabled={disabled()}
        creating={creating()}
        onSelect={(id) => calls.push(`select:${id}`)}
        onHide={(id) => calls.push(`hide:${id}`)}
        onNew={() => calls.push("new")}
        onReview={() => calls.push("review")}
        onAdversarial={() => calls.push("adversarial")}
      />
    ),
    host,
  );
  try {
    const session = host.querySelector<HTMLButtonElement>('[aria-label="Session 1"]')!;
    const fresh = host.querySelector<HTMLButtonElement>('button[title^="Start a fresh"]')!;
    const review = host.querySelector<HTMLButtonElement>(
      'button[title="Run a normal review in this conversation"]',
    )!;
    const adversarial = host.querySelector<HTMLButtonElement>(
      'button[title="Run an adversarial review in this conversation"]',
    )!;
    for (const width of [240, 320, 370, 600]) {
      host.style.width = `${width}px`;
      await new Promise(requestAnimationFrame);
      const a = session.getBoundingClientRect(),
        b = fresh.getBoundingClientRect(),
        c = review.getBoundingClientRect(),
        d = adversarial.getBoundingClientRect();
      check(
        a.top === b.top && a.height === b.height,
        `${width}px: session and New must align on one row`,
      );
      check(
        c.top > a.top && c.top === d.top,
        `${width}px: both review actions must share a deliberate second row`,
      );
      check(
        Math.abs(c.width - d.width) < 1 && c.height === d.height,
        `${width}px: review actions must have equal dimensions`,
      );
      for (const button of [session, fresh, review, adversarial]) {
        const range = document.createRange();
        range.selectNodeContents(button);
        const text = range.getBoundingClientRect(),
          bounds = button.getBoundingClientRect(),
          panel = host.getBoundingClientRect();
        check(
          text.width <= bounds.width && bounds.left >= panel.left && bounds.right <= panel.right,
          `${width}px: readable, unclipped control text`,
        );
      }
    }
    fresh.click();
    review.click();
    adversarial.click();
    check(
      calls.join(",") === "new,review,adversarial",
      "New/Run/Adversarial must each remain one-click actions",
    );
    session.click();
    host.querySelector<HTMLButtonElement>('button[aria-pressed="false"]')!.click();
    check(calls.at(-1) === "select:two", "saved session picker must still select directly");
    setDisabled(true);
    for (const button of [session, fresh, review, adversarial]) {
      check(button.disabled, "busy controls must stay disabled");
      button.click();
    }
    check(calls.length === 4, "disabled controls must not invoke actions");
    setCreating(true);
    check(
      fresh.textContent?.includes("Creating") ?? false,
      "creation feedback must remain visible",
    );
    return { ...result(), widths: [240, 320, 370, 600], calls };
  } finally {
    dispose();
    host.remove();
  }
}
