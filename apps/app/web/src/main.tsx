import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { AppShell } from './shell/app-shell';
import './styles.css';
import { ApiContext } from './api';
import { installStaleBuildDetection } from './build/stale-build';
import { LocalDevelopmentBar, workspaceClient } from './local-development';

const root = document.getElementById('root');
if (!root) throw new Error('Missing application root.');
const local = document.querySelector('meta[name="rf-local-sign-in"]')?.getAttribute('content') === 'enabled';
const client = workspaceClient(local);
installStaleBuildDetection();
createRoot(root).render(<StrictMode><ApiContext.Provider value={client}><LocalDevelopmentBar enabled={local} /><BrowserRouter><AppShell /></BrowserRouter></ApiContext.Provider></StrictMode>);
