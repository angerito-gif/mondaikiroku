// アイコンPNGを icon.svg から生成する（開発用。Playwright が必要）
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const svg = fs.readFileSync(path.join(__dirname, 'icon.svg'), 'utf8');
(async () => {
  const browser = await chromium.launch();
  for (const [name, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['apple-touch-icon.png', 180]]) {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    await page.setContent(`<style>*{margin:0}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
    await page.screenshot({ path: path.join(__dirname, name) });
    await page.close();
  }
  await browser.close();
})();
