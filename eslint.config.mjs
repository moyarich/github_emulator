import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/coverage/**",
      "**/node_modules/**",
      "**/build/**",
    ],
  },
  {
    files: ["**/*.{js,mjs,ts,tsx}"],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
);
