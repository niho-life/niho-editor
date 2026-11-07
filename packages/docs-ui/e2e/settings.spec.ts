import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { openScreen } from "./support/gallery";

for (const width of [320, 1280]) {
  test(`設定の本人情報と左下の入口（${width}px）`, async ({ page }) => {
    await openScreen(page, "settings-web", width);
    await expect(page.getByRole("heading", { name: "設定", exact: true })).toBeVisible();
    const settings = page.locator(".es-setbar button");
    await expect(settings).toHaveCount(1);
    await expect(settings.locator("b")).toHaveText("設定");
    await expect(settings.locator("svg")).toBeVisible();
    await expect(page.locator(".es-row--me")).toBeVisible();
    await expect(page.locator('a[href="/account"]')).toHaveCount(0);
    await expect(page.getByRole("link", { name: "名前を再取得" })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
    expect(result.violations.filter((item) => item.impact === "serious" || item.impact === "critical").map((item) => item.id)).toEqual([]);
    if (width === 320) await page.screenshot({ path: test.info().outputPath("settings-320.png") });
  });
}
