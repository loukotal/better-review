import { For, onCleanup, onMount } from "solid-js";
import {
  FileDiff,
  parsePatchFiles,
  SVGSpriteSheet,
  type FileDiffMetadata,
} from "@pierre/diffs";

interface Props {
  rawDiff: string;
}

function FileDiffView(props: { file: FileDiffMetadata }) {
  let containerRef: HTMLDivElement | undefined;
  let instance: FileDiff | undefined;

  onMount(async () => {
    if (!containerRef) return;

    console.log("File to render:", props.file);

    instance = new FileDiff({
      diffStyle: "split",
      theme: "github-dark",
      lineDiffType: "word",
      hunkSeparators: "line-info",
    });

    // Need to pass containerWrapper (parent element) for the component to attach to
    instance.render({
      fileDiff: props.file,
      containerWrapper: containerRef,
    });
    console.log("After render:", containerRef.innerHTML.slice(0, 500));
  });

  onCleanup(() => instance?.cleanUp());

  return <div class="border border-border rounded-lg" ref={containerRef} />;
}

export function DiffViewer(props: Props) {
  const files = () => {
    const patches = parsePatchFiles(props.rawDiff);
    return patches[0]?.files ?? [];
  };

  return (
    <div>
      <div innerHTML={SVGSpriteSheet} style="display:none" />
      <div class="flex flex-col gap-4">
        <For each={files()}>{(file) => <FileDiffView file={file} />}</For>
      </div>
    </div>
  );
}
