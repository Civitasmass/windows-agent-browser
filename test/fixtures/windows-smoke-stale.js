await cdp("Page.reload");
await page.waitForLoadState();

try {
  await page.click("@2");
  throw new Error("A ref from before reload was unexpectedly accepted.");
} catch (error) {
  if (error?.code !== "STALE_REF_DOCUMENT") throw error;
  console.log(
    JSON.stringify({
      staleRefRejected: true,
      code: error.code,
      title: (await page.info()).title,
    }),
  );
}
