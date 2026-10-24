export default {
  toc: { placement: "right", minDepth: 2, maxDepth: 3 },
  sources: {
    docs: {
      base: "../../docs",
      include: ["**/page.mdx"],
      navigation: { label: "Documentation", order: 1 },
    },
    examples: {
      base: "../../examples",
      include: ["**/page.mdx"],
      navigation: { label: "Examples", order: 2 },
    },
  },
} as const;
