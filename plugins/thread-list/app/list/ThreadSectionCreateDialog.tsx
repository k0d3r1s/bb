import { useId, useState, type FormEvent, type RefObject } from "react";
import { Button } from "@/components/ui/button";
import {
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { RenameDialog, useNameValidation } from "../ui/RenameDialog.js";

export interface NameCreateDialogCopy {
  title: string;
  description: string;
  inputLabel: string;
  submitLabel: string;
  emptyMessage: string;
}

const THREAD_SECTION_DIALOG_COPY: NameCreateDialogCopy = {
  title: "New section",
  description: "Create a section for threads.",
  inputLabel: "Section name",
  submitLabel: "Create section",
  emptyMessage: "Section name cannot be empty.",
};

interface ThreadSectionCreateDialogProps {
  errorMessage?: string | null;
  open: boolean;
  pending?: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (name: string) => void;
}

interface NameCreateDialogProps extends ThreadSectionCreateDialogProps {
  copy: NameCreateDialogCopy;
}

interface NameCreateDialogContentProps {
  copy: NameCreateDialogCopy;
  errorMessage?: string | null;
  pending: boolean;
  onSubmit: (name: string) => void;
  inputRef: RefObject<HTMLInputElement | null>;
}

export function ThreadSectionCreateDialog(
  props: ThreadSectionCreateDialogProps,
) {
  return <NameCreateDialog {...props} copy={THREAD_SECTION_DIALOG_COPY} />;
}

export function NameCreateDialog({
  copy,
  errorMessage,
  open,
  pending = false,
  onOpenChange,
  onCreate,
}: NameCreateDialogProps) {
  return (
    <RenameDialog open={open} onOpenChange={onOpenChange}>
      {(inputRef) =>
        open ? (
          <NameCreateDialogContent
            copy={copy}
            errorMessage={errorMessage}
            pending={pending}
            onSubmit={onCreate}
            inputRef={inputRef}
          />
        ) : null
      }
    </RenameDialog>
  );
}

function NameCreateDialogContent({
  copy,
  errorMessage,
  pending,
  onSubmit,
  inputRef,
}: NameCreateDialogContentProps) {
  const inputId = useId();
  const [name, setName] = useState("");
  const [hiddenErrorMessage, setHiddenErrorMessage] = useState<string | null>(
    null,
  );
  const { validationMessage, validate, clearMessage } = useNameValidation({
    emptyMessage: copy.emptyMessage,
  });

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;

    const trimmedName = validate(name);
    if (trimmedName === null) return;

    setHiddenErrorMessage(null);
    onSubmit(trimmedName);
  };
  const displayedServerMessage =
    errorMessage && hiddenErrorMessage !== errorMessage ? errorMessage : null;
  const displayedMessage = validationMessage ?? displayedServerMessage;

  return (
    <>
      <DialogHeader>
        <DialogTitle>{copy.title}</DialogTitle>
        <DialogDescription>{copy.description}</DialogDescription>
      </DialogHeader>
      <form className="space-y-4" onSubmit={handleSubmit}>
        <div className="space-y-2">
          <Input
            ref={inputRef}
            id={inputId}
            aria-label={copy.inputLabel}
            value={name}
            autoCapitalize="sentences"
            autoCorrect="off"
            spellCheck={false}
            disabled={pending}
            onChange={(event) => {
              setName(event.target.value);
              setHiddenErrorMessage(errorMessage ?? null);
              clearMessage();
            }}
          />
          {displayedMessage ? (
            <p className="text-sm text-destructive">{displayedMessage}</p>
          ) : null}
        </div>
        <DialogFooter>
          <Button type="submit" disabled={pending}>
            {copy.submitLabel}
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}
