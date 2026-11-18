import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

// react-native-markdown-display pulls in markdown-it ^10 (CVE-2022-21670 ReDoS,
// fixed in 12.3.2). The root package.json override must keep the resolved copy patched.
const requireFromDisplay = createRequire(
  createRequire(import.meta.url).resolve('react-native-markdown-display'),
);

describe('markdown-it used by react-native-markdown-display', () => {
  it('is patched for the ReDoS (>= 12.3.2)', () => {
    const { version } = requireFromDisplay('markdown-it/package.json') as { version: string };
    const [major, minor, patch] = version.split('.').map(Number);
    const patched =
      major > 12 || (major === 12 && (minor > 3 || (minor === 3 && patch >= 2)));
    expect(patched, `markdown-it ${version}`).toBe(true);
  });
});
