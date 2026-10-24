import type { StorybookConfig } from "@storybook/react-vite";

const config: StorybookConfig = {
  stories: [
    "../apps/**/*.stories.@(js|jsx|ts|tsx)",
    "../packages/**/*.stories.@(js|jsx|ts|tsx)",
    "../src/**/*.stories.@(js|jsx|ts|tsx)",
  ],
  addons: [],
  framework: { name: "@storybook/react-vite", options: {} },
};
export default config;
