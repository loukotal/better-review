import { splitProps, type JSX } from "solid-js";
export function Checkbox(
  props: Omit<JSX.InputHTMLAttributes<HTMLInputElement>, "type"> & { label: string },
) {
  const [local, rest] = splitProps(props, ["label", "class"]);
  return (
    <label class="inline-flex items-center gap-2 text-sm text-text-muted">
      <input type="checkbox" class={`size-4 accent-accent ${local.class ?? ""}`} {...rest} />
      <span>{local.label}</span>
    </label>
  );
}
