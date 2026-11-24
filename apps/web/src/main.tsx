import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
import './rich-block.css';
import './proposal-queue.css';

const container = document.getElementById('root');
if (!container) throw new Error('root element is missing');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
