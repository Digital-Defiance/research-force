import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router';
import './styles.css';

function Workspace() {
  return <main><h1>ResearchForce Workspace</h1><p>The collaborative research workspace is being built.</p></main>;
}

const root = document.getElementById('root');
if (!root) throw new Error('Missing application root.');
createRoot(root).render(<StrictMode><BrowserRouter><Routes><Route path="*" element={<Workspace />} /></Routes></BrowserRouter></StrictMode>);
