import "./CodeBlock.css";
import { CodeCopyIcon } from "../CodeBlock/CodeCopyIcon.js";
import {
  createContext,
  useContext,
  useRef,
  type ComponentPropsWithoutRef,
} from "react";
import { CopyButton } from "../CopyButton/CopyButton.js";

export const CodeGroupContext = createContext(false);
/** MDX pre renderer: preserves Shiki tokens and copies the rendered source text. */
export function CodeBlock({
  language,
  ...props
}: ComponentPropsWithoutRef<"pre"> & {
  language?: string;
  "data-language"?: string;
}) {
  const pre = useRef<HTMLPreElement>(null);
  const grouped = useContext(CodeGroupContext);
  const label = language ?? props["data-language"];
  if (grouped) return <pre {...props} />;
  return (
    <div data-moyaforge-code-block="">
      {label && (
        <span data-moyaforge-code-language="" aria-hidden="true">
          {label}
        </span>
      )}
      <CopyButton
        icon={<CodeCopyIcon />}
        className="mf-code-copy"
        aria-label="Copy code"
        getValue={() => pre.current?.textContent ?? ""}
      />
      <pre ref={pre} {...props} />
    </div>
  );
}
