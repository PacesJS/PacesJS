import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { httpHostAdapter, startHeartbeat } from './host/http';
import './theme/fonts.css';
import './theme/tokens.css';
import './styles/base.css';
import './styles/shell.css';
import './styles/views.css';
import './styles/browser.css';
import './styles/motion.css';

const root = document.getElementById('root');
if (root) {
  startHeartbeat();
  createRoot(root).render(<App host={httpHostAdapter()} />);
}
