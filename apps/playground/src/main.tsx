import { createRoot } from "react-dom/client";

const root = document.getElementById("root");
if (!root) throw new Error("Missing playground root element");

createRoot(root).render(<main>Monorepo playground</main>);
