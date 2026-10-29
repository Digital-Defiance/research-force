import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { Workspace } from './routes';
import './styles.css';
import { ApiContext } from './api';
import { LocalDevelopmentBar, workspaceClient } from './local-development';

const root = document.getElementById('root');
if (!root) throw new Error('Missing application root.');
const local = document.querySelector('meta[name="rf-local-sign-in"]')?.getAttribute('content') === 'enabled';
const client = workspaceClient(local);
createRoot(root).render(<StrictMode><ApiContext.Provider value={client}><LocalDevelopmentBar enabled={local} /><BrowserRouter><Workspace /></BrowserRouter></ApiContext.Provider></StrictMode>);
