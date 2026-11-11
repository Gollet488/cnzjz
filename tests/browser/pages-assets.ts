import { expect, type Page, type TestInfo } from '@playwright/test';

export function trackPagesAssets(page: Page, info: TestInfo) {
  const responses: { url: string; status: number }[] = [];
  if (info.project.name === 'pages') {
    page.context().on('response', (response) => {
      if (
        /\/assets\/offline\.worker-|\/pose-inference\.worker\.js|\/mediapipe\/|\/ffmpeg\//.test(
          response.url(),
        )
      )
        responses.push({ url: response.url(), status: response.status() });
    });
  }
  return async (...expected: RegExp[]) => {
    if (info.project.name !== 'pages') return;
    await info.attach('asset-responses', {
      body: JSON.stringify(responses, null, 2),
      contentType: 'application/json',
    });
    const base = new URL(info.project.use.baseURL!);
    for (const { url, status } of responses) {
      expect(url.startsWith(base.href), url).toBe(true);
      expect(status, url).toBe(200);
    }
    for (const path of expected)
      expect(
        responses.some(({ url }) => path.test(new URL(url).pathname)),
        String(path),
      ).toBe(true);
  };
}
