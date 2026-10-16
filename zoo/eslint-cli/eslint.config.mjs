// Config for the eslint-cli zoo app: typescript-eslint and react-hooks give the profile plugin
// packages to drill into. Resolved from the repository's node_modules.
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(...tseslint.configs.recommended, {
  plugins: { 'react-hooks': reactHooks },
  rules: {
    'react-hooks/rules-of-hooks': 'error',
    'react-hooks/exhaustive-deps': 'warn',
    eqeqeq: 'error',
    'no-var': 'error',
  },
});
