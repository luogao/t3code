import { createFileRoute } from "@tanstack/react-router";

import { FridayCanvasPage } from "../friday/FridayCanvasPage";

export const Route = createFileRoute("/_chat/friday")({
  component: FridayCanvasPage,
});
