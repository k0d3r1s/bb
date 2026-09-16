export const forkHostCommandWakePolicy = {
  "work.quiesce": "never",
  "work.seal": "never",
  "work.unquiesce": "never",
} satisfies Record<string, "never" | "work">;
