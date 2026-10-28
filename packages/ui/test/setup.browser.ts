import { afterEach, beforeEach } from 'vitest';
import { cleanup } from '@testing-library/react';
// The app's own stylesheets, in the order main.tsx loads them: a browser test of layout is only as
// real as the CSS it runs with.
import '../src/theme/fonts.css';
import '../src/theme/tokens.css';
import '../src/styles/base.css';
import '../src/styles/shell.css';
import '../src/styles/views.css';
import '../src/styles/browser.css';
import '../src/styles/motion.css';

beforeEach(() => {
  history.replaceState(null, '', '#');
});

afterEach(() => cleanup());
