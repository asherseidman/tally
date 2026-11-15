import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { QuickWindow } from './QuickWindow';
import { startAppearance } from './appearance';
import './styles.css';

// The small quick-add window loads this same page with #quick.
const quick = window.location.hash === '#quick';
if (quick) document.documentElement.classList.add('quick');

startAppearance();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {quick ? <QuickWindow /> : <App />}
  </StrictMode>,
);
