import { splitProps, type ComponentProps } from "solid-js";

import { Button } from "./Button";

export function IconButton(props: ComponentProps<typeof Button> & { label: string }) {
  const [local, rest] = splitProps(props, ["label"]);
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={local.label}
      title={local.label}
      {...rest}
    />
  );
}
