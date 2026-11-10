import { UI_DISPLAY_SETTINGS_KEY, initializeUiDisplay } from "../lib/ui-display";
import { createAssertions } from "./assertions";
import { mountAppFixture } from "./mount-app";

const codeRowHeight = () => {
  for (const container of document.querySelectorAll("diffs-container")) {
    const row = container.shadowRoot?.querySelector<HTMLElement>("[data-line]");
    const height = row?.getBoundingClientRect().height;
    if (height) return height;
  }
  return 0;
};
const headerHeight = () => document.querySelector(".app-header")!.getBoundingClientRect().height;
const rootFontSize = () => getComputedStyle(document.documentElement).fontSize;

export async function testCompactUiAndZoomOutSettingsInBrowser() {
  const { check, wait, result } = createAssertions(3000);
  localStorage.removeItem(UI_DISPLAY_SETTINGS_KEY);
  initializeUiDisplay();
  let dispose = await mountAppFixture();
  await wait(() => codeRowHeight() > 0, "Diff rows did not render");
  check(codeRowHeight() === 18, `First painted code row is ${codeRowHeight()}px, not compact`);
  const before = { header: headerHeight(), row: codeRowHeight() };
  check(rootFontSize() === "16px", `Default root font size is ${rootFontSize()}`);
  check(document.documentElement.dataset.uiDensity === "compact", "Compact is not the default");

  const open = async () => {
    document.querySelector<HTMLButtonElement>('button[aria-label="Review settings"]')!.click();
    await wait(
      () => !!document.querySelector('[popover]:popover-open select[aria-label="Zoom"]'),
      "Display settings missing",
    );
    const popover = document.querySelector("[popover]:popover-open")!;
    return {
      compact: popover.querySelector<HTMLInputElement>('input[name="compact-ui"]')!,
      zoom: popover.querySelector<HTMLSelectElement>('select[aria-label="Zoom"]')!,
    };
  };

  let controls = await open();
  check(controls.compact.checked && controls.zoom.value === "100", "Defaults not shown");
  controls.compact.click();
  await window.dismissBrowserPopover("escape");
  await wait(() => codeRowHeight() === 20, "Comfortable mode did not relax code rows");
  check(
    document.documentElement.dataset.uiDensity === "comfortable",
    "Comfortable flag not applied",
  );
  check(headerHeight() > before.header, "Compact mode did not tighten the header");

  controls = await open();
  controls.zoom.value = "80";
  controls.zoom.dispatchEvent(new Event("change", { bubbles: true }));
  await window.dismissBrowserPopover("escape");
  await wait(() => rootFontSize() === "12.8px", "Zoom 80% did not scale the root font size");
  await wait(() => codeRowHeight() === 16, "Zoom did not scale code rows");
  check(
    JSON.stringify(JSON.parse(localStorage.getItem(UI_DISPLAY_SETTINGS_KEY)!)) ===
      JSON.stringify({ density: "comfortable", zoom: 80 }),
    "Display settings were not persisted",
  );

  dispose();
  initializeUiDisplay();
  dispose = await mountAppFixture({ initialPath: "/", waitForFiles: false });
  controls = await open();
  check(!controls.compact.checked && controls.zoom.value === "80", "Reload lost display settings");
  check(rootFontSize() === "12.8px", "Reload lost zoom");
  controls.compact.click();
  controls.zoom.value = "100";
  controls.zoom.dispatchEvent(new Event("change", { bubbles: true }));
  await wait(
    () => rootFontSize() === "16px" && document.documentElement.dataset.uiDensity === "compact",
    `Display settings did not reset: ${rootFontSize()} ${document.documentElement.dataset.uiDensity} ${controls.compact.checked}`,
  );
  await window.dismissBrowserPopover("escape");
  dispose();
  return result();
}
