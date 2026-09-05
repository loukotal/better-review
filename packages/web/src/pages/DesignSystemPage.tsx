import { createSignal, For, type JSX } from "solid-js";

import { AppHeader } from "../components/AppHeader";
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  Dialog,
  EmptyState,
  Field,
  IconButton,
  LoadingState,
  PanelHeader,
  Popover,
  SegmentedControl,
  Select,
  Textarea,
  TextInput,
} from "../design-system";

const COMPONENTS = [
  ["AppHeader", "Application navigation and page tools"],
  ["Button / IconButton", "Actions with consistent geometry and accessible names"],
  ["SegmentedControl", "Exclusive selection with neutral emphasis"],
  ["Field", "Unique labels associated with their controls"],
  ["TextInput / Textarea / Select", "Text, comments, and choices"],
  ["Checkbox", "Independent on/off choices"],
  ["Badge", "Neutral, success, warning, danger, info, and merged states"],
  ["Alert", "Status and actionable errors"],
  ["LoadingState / EmptyState", "Distinct loading and empty results"],
  ["Popover", "Top-layer settings, descriptions, and selectors"],
  ["Dialog", "Modal decisions with keyboard focus containment"],
  ["PanelHeader / Card", "Panel structure and grouped content"],
];

function Example(props: { title: string; description: string; children: JSX.Element }) {
  return (
    <section class="min-w-0 space-y-4 border-b border-border py-6">
      <div>
        <h2 class="text-base font-medium text-text">{props.title}</h2>
        <p class="mt-1 text-sm text-text-muted">{props.description}</p>
      </div>
      {props.children}
    </section>
  );
}

export default function DesignSystemPage() {
  const [view, setView] = createSignal("diff");
  const [checked, setChecked] = createSignal(true);
  const [dialogOpen, setDialogOpen] = createSignal(false);
  return (
    <div class="min-h-screen bg-bg text-text">
      <AppHeader constrained />
      <main class="mx-auto max-w-6xl px-4 py-6">
        <h1 class="text-xl font-semibold">UI components</h1>
        <p class="mt-2 max-w-2xl text-sm leading-6 text-text-muted">
          Production components used by the PR list, review workspace, and agent review. Changes
          here come from the shared implementations, not separate preview markup.
        </p>
        <details class="mt-5 border-y border-border py-3">
          <summary class="cursor-pointer text-sm font-medium">Component inventory</summary>
          <table class="mt-3 w-full text-left text-sm">
            <thead>
              <tr class="border-b border-border">
                <th scope="col" class="py-2 pr-4 font-medium">
                  Component
                </th>
                <th scope="col" class="py-2 font-medium">
                  Purpose
                </th>
              </tr>
            </thead>
            <tbody>
              <For each={COMPONENTS}>
                {([name, description]) => (
                  <tr class="border-b border-border/50">
                    <td class="py-2 pr-4 font-mono text-xs">{name}</td>
                    <td class="py-2 text-text-muted">{description}</td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </details>
        <div class="grid gap-x-10 lg:grid-cols-2">
          <Example
            title="Actions"
            description="Primary emphasis belongs to actions. All variants keep the same geometry."
          >
            <div class="flex flex-wrap items-center gap-2">
              <Button type="button" variant="primary">
                Primary
              </Button>
              <Button type="button">Secondary</Button>
              <Button type="button" variant="ghost">
                Quiet action
              </Button>
              <Button type="button" variant="danger">
                Destructive
              </Button>
              <Button type="button" variant="success">
                Approve
              </Button>
              <Button type="button" disabled>
                Disabled
              </Button>
              <IconButton label="Example icon action">+</IconButton>
            </div>
            <div class="flex flex-wrap items-center gap-2">
              <Button type="button" size="xs">
                Extra small
              </Button>
              <Button type="button" size="sm">
                Small
              </Button>
              <Button type="button" size="md">
                Default
              </Button>
              <Button type="button" size="lg">
                Large
              </Button>
            </div>
          </Example>
          <Example
            title="Selection"
            description="Current selection is neutral and announced to assistive technology."
          >
            <SegmentedControl
              label="Example review view"
              value={view()}
              onChange={setView}
              options={[
                { value: "diff", label: "Diff" },
                { value: "reading", label: "Reading" },
                { value: "unavailable", label: "Unavailable", disabled: true },
              ]}
            />
            <Checkbox
              label="Show inline comments"
              checked={checked()}
              onChange={(e) => setChecked(e.currentTarget.checked)}
            />
          </Example>
          <Example
            title="Fields"
            description="Associated labels, consistent sizing, and native form semantics."
          >
            <div class="space-y-4">
              <Field label="Pull request URL">
                {(id) => <TextInput id={id} placeholder="github.com/owner/repo/pull/123" />}
              </Field>
              <Field label="Find a file">
                {(id) => <TextInput id={id} type="search" size="sm" placeholder="Filter files…" />}
              </Field>
              <Field label="Code theme">
                {(id) => (
                  <Select id={id}>
                    <option>GitHub dark</option>
                    <option>GitHub light</option>
                  </Select>
                )}
              </Field>
              <Field label="Unavailable field">
                {(id) => <TextInput id={id} disabled value="Disabled" />}
              </Field>
            </div>
          </Example>
          <Example
            title="Comments and validation"
            description="Errors retain their styling when focused and expose invalid state."
          >
            <div class="space-y-4">
              <Field label="Comment">
                {(id) => <Textarea id={id} rows={3} placeholder="Write a comment…" />}
              </Field>
              <Field label="Invalid example">
                {(id) => (
                  <>
                    <Textarea id={id} intent="danger" aria-describedby={`${id}-error`} rows={2} />
                    <p id={`${id}-error`} class="text-sm text-error">
                      Add a comment before submitting.
                    </p>
                  </>
                )}
              </Field>
              <Textarea aria-label="Disabled comment" disabled placeholder="Disabled" />
            </div>
          </Example>
          <Example
            title="Status"
            description="Status uses semantic theme colors and explicit labels."
          >
            <div class="flex flex-wrap gap-2">
              <Badge>Draft</Badge>
              <Badge variant="success">Approved</Badge>
              <Badge variant="warning">Changes requested</Badge>
              <Badge variant="danger">Failed</Badge>
              <Badge variant="info">In progress</Badge>
              <Badge variant="merged">Merged</Badge>
            </div>
            <Alert intent="warning" title="Checks are still running">
              You can continue reviewing while checks finish.
            </Alert>
            <Alert intent="danger" title="Could not load review">
              Check the connection and try again.
            </Alert>
          </Example>
          <Example
            title="Overlays"
            description="Escape dismisses overlays and restores focus. Dialogs contain keyboard focus."
          >
            <div class="flex flex-wrap items-center gap-2">
              <Popover label="Example settings">
                <Field label="Session name">
                  {(id) => <TextInput id={id} placeholder="My review" />}
                </Field>
              </Popover>
              <Popover label="Example description" width={480}>
                <p class="text-sm leading-6 text-text-muted">
                  Descriptions share the same popover behavior as settings and selectors, including
                  viewport positioning and outside dismissal.
                </p>
              </Popover>
              <Button type="button" onClick={() => setDialogOpen(true)}>
                Open example dialog
              </Button>
            </div>
            <Dialog open={dialogOpen()} onClose={() => setDialogOpen(false)} title="Example dialog">
              <p class="text-sm leading-6 text-text-muted">
                This is the same dialog used for unsent-comment decisions in agent review.
              </p>
              <div class="mt-4 flex justify-end">
                <Button type="button" autofocus onClick={() => setDialogOpen(false)}>
                  Close example
                </Button>
              </div>
            </Dialog>
          </Example>
          <Example
            title="Loading and empty results"
            description="An empty result is distinct from an operation in progress."
          >
            <LoadingState label="Loading review…" />
            <EmptyState
              title="No matching pull requests"
              description="Change a filter to widen the queue."
            />
          </Example>
          <Example
            title="Panel structure"
            description="Consistent heading and action placement for supporting content."
          >
            <div class="border border-border">
              <PanelHeader
                title="Review assistant"
                actions={
                  <Button type="button" variant="primary" size="sm">
                    Review
                  </Button>
                }
              />
              <div class="p-3 text-sm text-text-muted">Panel content</div>
            </div>
            <Card variant="subtle">
              <p class="text-sm text-text-muted">
                Use a card when content forms a distinct group; use spacing for ordinary layout.
              </p>
            </Card>
          </Example>
        </div>
      </main>
    </div>
  );
}
