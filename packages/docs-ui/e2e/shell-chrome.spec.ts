import { expect, test } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";

for (const mode of [{ width: 1280, mac: false }, { width: 1280, mac: true }, { width: 320, mac: false }]) {
  test(`枠・時刻・フォルダ・スクロール（${mode.width}px / mac=${mode.mac}）`, async ({ page }) => {
    await page.setViewportSize({ width: mode.width, height: 820 });
    await page.goto(`/#/split${mode.mac ? "?mac=1" : ""}`);
    const root = page.locator(".es-root");
    const box = await root.boundingBox();
    expect(box!.y).toBe(mode.mac ? 32 : 0);
    expect(box!.y + box!.height).toBe(820);
    if (mode.mac) expect((await page.locator(".es-brand").boundingBox())!.y).toBeGreaterThanOrEqual(32);
    await expect(page.locator(".es-when, .es-ditw")).toHaveCount(0);

    const folder = page.getByRole("button", { name: "合成フォルダ", exact: true });
    const child = page.getByRole("button", { name: "フォルダ内の合成ページ", exact: true });
    const plain = page.getByRole("button", { name: "合成参考ページ", exact: true });
    expect((await folder.locator("svg").boundingBox())!.x).toBeCloseTo((await plain.locator(".es-di-t").boundingBox())!.x);
    await folder.locator("svg").click();
    await expect(folder).toHaveAttribute("aria-expanded", "false");
    await expect(child).toHaveCount(0);
    await folder.locator(".es-di-t").click();
    await expect(folder).toHaveAttribute("aria-expanded", "true");
    await expect(child).toBeVisible();
    await folder.focus();
    await page.keyboard.press("Space");
    await expect(folder).toHaveAttribute("aria-expanded", "false");
    await page.keyboard.press("Enter");
    await expect(folder).toHaveAttribute("aria-expanded", "true");
    await plain.click();
    if (mode.width < 900) await page.getByRole("button", { name: "一覧をしまう", exact: true }).click();

    const main = page.locator("#es-main");
    const tab = page.locator(".es-tabbar");
    await expect(main).toBeVisible();
    // タブの帯は題名の下・本文の前（#344）。上に貼りつけず、本文と一緒に送られる
    const titleBox = (await main.locator("h1").boundingBox())!;
    const tabBox = (await tab.boundingBox())!;
    expect(tabBox.y).toBeGreaterThanOrEqual(titleBox.y + titleBox.height - 1);
    expect(tabBox.y + tabBox.height).toBeLessThanOrEqual((await main.locator(".es-body").boundingBox())!.y + 1);
    await main.evaluate((element) => { element.scrollTop = 600; });
    await expect.poll(async () => (await tab.boundingBox())!.y).toBeLessThan(tabBox.y - 500);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    const accessibility = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
    expect(accessibility.violations.filter((item) => item.impact === "serious" || item.impact === "critical").map((item) => item.id)).toEqual([]);
    if (mode.mac) await page.screenshot({ path: test.info().outputPath("mac-scrolled.png") });
  });
}
