import { test, expect } from "@playwright/test";

test("smoke: open page", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle(/Example Domain/);
});
