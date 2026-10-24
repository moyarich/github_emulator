/// <reference types="mdx" />

declare module "virtual:moyaforge-mdx/metadata" {
  export interface RegistryPage {
    source: string;
    file: string;
    path: string;
    title: string;
    label: string;
    description?: string;
  }
  export const routes: RegistryPage[];
  export const navigation: RegistryPage[];
}

declare module "virtual:moyaforge-mdx/lazy-registry" {
  export const sources: Record<
    string,
    {
      lazyPages: Record<
        string,
        () => Promise<{ default: import("mdx/types").MDXContent }>
      >;
    }
  >;
}
