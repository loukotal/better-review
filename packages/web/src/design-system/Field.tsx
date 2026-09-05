import { createUniqueId, type JSX } from "solid-js";
export function Field(props: { label: string; children: (id: string) => JSX.Element }) {
  const id = createUniqueId();
  return (
    <div class="flex flex-col gap-1.5">
      <label for={id} class="text-xs font-medium text-text-muted">
        {props.label}
      </label>
      {props.children(id)}
    </div>
  );
}
