const fs = require('fs');
const path = require('path');

const files = {
  'playwright.config.ts': `import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
`,
  'tests/example.spec.ts': `import { test, expect } from '@playwright/test';

test('Playwright-Startseite hat den richtigen Titel', async ({ page }) => {
  await page.goto('https://playwright.dev/');
  await expect(page).toHaveTitle(/Playwright/);
});

test('Link "Get started" führt zur Installationsseite', async ({ page }) => {
  await page.goto('https://playwright.dev/');
  await page.getByRole('link', { name: 'Get started' }).click();
  await expect(page.getByRole('heading', { name: 'Installation' })).toBeVisible();
});
`,
  '.gitignore': `node_modules/
test-results/
playwright-report/
blob-report/
`,
  // Lets the project also run outside the app with a normal "npm install".
  'package.json': `{
  "name": "playwright-tests",
  "private": true,
  "scripts": { "test": "playwright test" },
  "devDependencies": { "@playwright/test": "^1.50.0" }
}
`,
};

function createProject(dir) {
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(dir, rel);
    if (fs.existsSync(target)) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
}

function isPlaywrightProject(dir) {
  return ['ts', 'js', 'mjs', 'cjs', 'mts'].some((ext) => fs.existsSync(path.join(dir, `playwright.config.${ext}`)));
}

module.exports = { createProject, isPlaywrightProject };
