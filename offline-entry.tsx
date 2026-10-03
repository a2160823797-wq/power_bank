import { createRoot } from 'react-dom/client';
import Home from './app/page';
import './app/globals.css';

const root = document.getElementById('root');

if (!root) {
  throw new Error('找不到页面根节点');
}

createRoot(root).render(<Home />);
