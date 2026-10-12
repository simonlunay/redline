import { expect, test } from '@playwright/test';

/** Phones: the gallery, a run and the landing page work, with no sideways scrolling. */
for (const path of [
  '/',
  '/gallery/',
  '/runs/fix-worst/',
  '/runs/yoga-retreat-tuned/?frame=7',
  '/check/',
]) {
  test(`fits a phone: ${path}`, async ({ page }) => {
    await page.goto(path);
    await expect(page.locator('main')).toBeVisible();
    await page.waitForTimeout(500);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
}
