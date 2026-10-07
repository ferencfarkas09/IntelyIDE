import "./editor.css";
import { createSignal, type JSX } from "solid-js";
import { render } from "solid-js/web";
import { t } from "../../i18n";
import { Button, Dialog, Input } from "../../ui-kit";

/** Opens a dialog from plain code (a tab close veto, a context-menu action) and resolves with the answer. */
export function showDialog<T>(view: (answer: (value: T) => void, open: () => boolean) => JSX.Element): Promise<T> {
  return new Promise((resolve) => {
    const host = document.createElement("div");
    document.body.append(host);
    const [open, setOpen] = createSignal(true);
    let dispose = () => {};
    const answer = (value: T) => {
      if (!open()) return;
      setOpen(false);
      resolve(value);
      // The dialog fades out first; unmount afterwards.
      setTimeout(() => (dispose(), host.remove()), 300);
    };
    dispose = render(() => view(answer, open), host);
  });
}

export interface ConfirmOptions<E extends string = never> {
  title: string;
  description?: string;
  confirmLabel: string;
  danger?: boolean;
  /** A second choice between Cancel and the main action, e.g. "Discard". */
  extra?: { id: E; label: string; danger?: boolean };
}

export function confirmDialog<E extends string = never>(o: ConfirmOptions<E>): Promise<"confirm" | "cancel" | E> {
  return showDialog<"confirm" | "cancel" | E>(
    (answer, open) => (
      <Dialog
        open={open()}
        onClose={() => answer("cancel")}
        title={o.title}
        description={o.description}
        size="sm"
        role="alertdialog"
        footer={
          <>
            <Button variant="ghost" onClick={() => answer("cancel")}>
              {t("editor.dialog.cancel")}
            </Button>
            {o.extra && (
              <Button variant={o.extra.danger ? "danger" : "secondary"} onClick={() => answer(o.extra!.id)}>
                {o.extra.label}
              </Button>
            )}
            <Button variant={o.danger ? "danger" : "primary"} data-autofocus onClick={() => answer("confirm")}>
              {o.confirmLabel}
            </Button>
          </>
        }
      />
    ),
  );
}

export interface PromptOptions {
  title: string;
  label: string;
  initial?: string;
  confirmLabel: string;
  /** Returns the reason a value is not acceptable. */
  validate?: (value: string) => string | undefined;
}

/** Asks for one line of text; resolves null when cancelled. */
export function promptDialog(o: PromptOptions): Promise<string | null> {
  return showDialog<string | null>(
    (answer, open) => {
      const [value, setValue] = createSignal(o.initial ?? "");
      const problem = () => o.validate?.(value());
      const submit = () => !problem() && answer(value().trim());
      return (
        <Dialog
          open={open()}
          onClose={() => answer(null)}
          title={o.title}
          size="sm"
          footer={
            <>
              <Button variant="ghost" onClick={() => answer(null)}>
                {t("editor.dialog.cancel")}
              </Button>
              <Button variant="primary" disabled={!!problem()} onClick={submit}>
                {o.confirmLabel}
              </Button>
            </>
          }
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <Input
              data-autofocus
              aria-label={o.label}
              placeholder={o.label}
              value={value()}
              invalid={value() !== (o.initial ?? "") && !!problem()}
              onInput={(e) => setValue(e.currentTarget.value)}
              onFocus={(e) => {
                const dot = e.currentTarget.value.lastIndexOf(".");
                e.currentTarget.setSelectionRange(0, dot > 0 ? dot : e.currentTarget.value.length);
              }}
            />
            <p class="editor-dialog__hint" role="status">
              {value() !== (o.initial ?? "") ? problem() : undefined}
            </p>
          </form>
        </Dialog>
      );
    },
  );
}
