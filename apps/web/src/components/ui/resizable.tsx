import { GripVerticalIcon } from "lucide-react";
import * as ResizablePrimitive from "react-resizable-panels";

import { cn } from "../../lib/utils";

/**
 * Thin wrappers around `react-resizable-panels` styled to match the
 * AgentScience design system. The handle is intentionally subtle — a
 * hair-line divider that highlights on hover and reveals a grip while
 * dragging — so resizing feels like a native Mac-style affordance rather
 * than a widget.
 */
function ResizablePanelGroup({
  className,
  ...props
}: React.ComponentProps<typeof ResizablePrimitive.PanelGroup>) {
  return (
    <ResizablePrimitive.PanelGroup
      data-slot="resizable-panel-group"
      className={cn(
        "flex h-full w-full data-[panel-group-direction=vertical]:flex-col",
        className,
      )}
      {...props}
    />
  );
}

function ResizablePanel({
  className,
  ...props
}: React.ComponentProps<typeof ResizablePrimitive.Panel>) {
  return (
    <ResizablePrimitive.Panel
      data-slot="resizable-panel"
      className={cn("relative flex min-w-0 min-h-0 flex-col", className)}
      {...props}
    />
  );
}

function ResizableHandle({
  withHandle = false,
  className,
  ...props
}: React.ComponentProps<typeof ResizablePrimitive.PanelResizeHandle> & {
  withHandle?: boolean;
}) {
  return (
    <ResizablePrimitive.PanelResizeHandle
      data-slot="resizable-handle"
      className={cn(
        // Keep the visible divider at 1px but give the drag target a wider
        // hit box (similar to how VS Code / Finder columns behave). The
        // hit box is centered via negative margins so it doesn't shift
        // adjacent content.
        "group relative flex w-px shrink-0 items-center justify-center bg-border outline-none transition-colors",
        "hover:bg-accent/50 focus-visible:bg-accent data-[resize-handle-state=drag]:bg-accent",
        "data-[resize-handle-state=hover]:bg-accent/70",
        // Expand the hover/drag target horizontally without affecting layout.
        "after:absolute after:inset-y-0 after:-inset-x-1 after:content-['']",
        "data-[panel-group-direction=vertical]:h-px data-[panel-group-direction=vertical]:w-full",
        "data-[panel-group-direction=vertical]:after:inset-x-0 data-[panel-group-direction=vertical]:after:-inset-y-1",
        "[&[data-panel-group-direction=vertical]>div]:rotate-90",
        className,
      )}
      {...props}
    >
      {withHandle ? (
        <div className="z-10 flex h-6 w-3 items-center justify-center rounded-sm border border-border bg-background opacity-0 shadow-sm transition-opacity group-hover:opacity-100 group-data-[resize-handle-state=drag]:opacity-100">
          <GripVerticalIcon className="size-2.5 text-ink-faint" />
        </div>
      ) : null}
    </ResizablePrimitive.PanelResizeHandle>
  );
}

export { ResizablePanelGroup, ResizablePanel, ResizableHandle };
