import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  reporter: [["html"]],
  use: {
    baseURL: "https://example.com",
  },
});
