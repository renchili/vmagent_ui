import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'docs', 'vmagent-ui-screenshot.png');
const url = process.env.SCREENSHOT_URL || 'http://127.0.0.1:3099';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1400 } });
await page.goto(url, { waitUntil: 'networkidle' });
await page.screenshot({ path: output, fullPage: true });
await browser.close();
console.log(output);
