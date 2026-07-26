await page.click("@2");
await page.fill("@3", "Round2");
console.log(
  JSON.stringify(
    await page.evaluate(() => ({
      clicked: document.body.dataset.clicked,
      value: document.querySelector("input")?.value,
      title: document.title,
    })),
  ),
);
