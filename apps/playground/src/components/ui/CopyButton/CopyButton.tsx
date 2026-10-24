import "./CopyButton.css";
import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type ComponentPropsWithoutRef,
} from "react";

export interface CopyButtonProps extends Omit<
  ComponentPropsWithoutRef<"button">,
  "value"
> {
  value?: unknown;
  getValue?: () => string;
  icon?: ReactNode;
  onCopy?: () => void;
}
export function CopyButton({
  value,
  getValue,
  icon,
  children = "Copy",
  onCopy,
  ...props
}: CopyButtonProps) {
  const [status, setStatus] = useState<"idle" | "copied" | "error">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  async function copy() {
    try {
      await navigator.clipboard.writeText(
        getValue ? getValue() : String(value ?? ""),
      );
      setStatus("copied");
      onCopy?.();
    } catch {
      setStatus("error");
    }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setStatus("idle"), 2000);
  }
  return (
    <button
      type="button"
      data-moyaforge-copy-button=""
      data-copy-status={status}
      onClick={copy}
      {...props}
    >
      {icon}
      <span aria-live="polite">
        {status === "copied"
          ? "Copied!"
          : status === "error"
            ? "Retry copy"
            : children}
      </span>
    </button>
  );
}
