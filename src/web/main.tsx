import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { isTauri } from '@tauri-apps/api/core';
import { App } from './App.js';
import { ServerPicker } from './pages/ServerPicker.js';
import { getServerUrl } from './lib/serverConfig.js';
import { setApiBaseUrl } from './lib/api.js';
import { applyTheme, getThemePref, subscribeSystemTheme } from './ui/theme.js';
import './index.css';

function Root() {
  const [serverUrl, setServerUrlState] = useState<string | null>(null);

  useEffect(() => {
    getServerUrl().then((url) => {
      setApiBaseUrl(url);
      setServerUrlState(url);
    }).catch(() => setServerUrlState(''));
  }, []);

  useEffect(() => {
    return subscribeSystemTheme((theme) => {
      if (getThemePref() === 'system') applyTheme(theme);
    });
  }, []);

  if (serverUrl === null) return null;

  if (isTauri() && serverUrl === '') {
    return (
      <ServerPicker
        onConnect={(url) => {
          setApiBaseUrl(url);
          setServerUrlState(url);
        }}
      />
    );
  }

  return (
    <BrowserRouter>
      <App />
    </BrowserRouter>
  );
}

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Root element #root not found in DOM');
ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
);
