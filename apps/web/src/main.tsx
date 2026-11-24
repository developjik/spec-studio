import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { SubscriptionNotice } from './subscription-notice';
import './styles.css';
import './run-panel.css';

const container = document.getElementById('root');
if (!container) throw new Error('root element is missing');

createRoot(container).render(
  <StrictMode>
    <App />
    <SubscriptionNotice />
  </StrictMode>,
);
