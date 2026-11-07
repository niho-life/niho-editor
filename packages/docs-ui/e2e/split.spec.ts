import { expect, test } from "@playwright/test";

test("左のページを右レールへ実際にドラッグすると、メインと入力を保って分割表示する", async ({ page }) => {
  await page.setViewportSize({ width: 1680, height: 900 });
  await page.goto("/#/split");
  const source = (title: string) => page.getByRole("button", { name: new RegExp(`^${title}`) }).locator("..");
  const main = page.locator("#es-main");
  const side = page.getByRole("region", { name: "右に並べたページ" });
  const draft = page.getByRole("textbox", { name: "AIへのメッセージ" });
  await draft.fill("ドラッグ前の書きかけ");
  // 落とし先の印が出る前の、右レールの中央。本文の列の外へ落とす。
  const rail = await page.locator('.es-pn[data-panel="ai"]').boundingBox();
  expect(rail).not.toBeNull();
  const target = { x: rail!.x + rail!.width / 2, y: rail!.y + rail!.height / 2 };
  const dragToRail = async (title: string) => {
    const box = await source(title).boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + 50, box!.y + box!.height / 2);
    await page.mouse.down();
    await page.mouse.move(target.x, target.y, { steps: 15 });
    await page.mouse.move(target.x, target.y + 1);
    await expect(page.locator('[data-zone="side"]')).toBeVisible();
    await expect(page.locator(".es-dzs")).toHaveText("");
    await page.mouse.up();
  };
  await dragToRail("合成参考ページ");
  await expect(side).toContainText("合成参考ページの本文");
  await expect(main).toContainText("合成メイン");
  await expect(draft).toHaveValue("ドラッグ前の書きかけ");
  await dragToRail("合成第三ページ");
  await expect(side).toContainText("合成第三ページの本文");
  await expect(main).toContainText("合成メイン");
  await expect(draft).toHaveValue("ドラッグ前の書きかけ");
});
