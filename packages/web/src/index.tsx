/* @refresh reload */
import './index.css';
import { render } from 'solid-js/web';
import { Router, Route } from '@solidjs/router';
import { QueryClientProvider } from '@tanstack/solid-query';
import 'solid-devtools';

import App from './App';
import PrListPage from './pages/PrListPage';
import { queryClient, restoreCache } from './lib/query';

// Restore cache from IndexedDB on startup
restoreCache();

const root = document.getElementById('root');

if (import.meta.env.DEV && !(root instanceof HTMLElement)) {
  throw new Error(
    'Root element not found. Did you forget to add it to your index.html? Or maybe the id attribute got misspelled?',
  );
}

render(
  () => (
    <QueryClientProvider client={queryClient}>
      <Router>
        <Route path="/" component={PrListPage} />
        <Route path="/review" component={App} />
      </Router>
    </QueryClientProvider>
  ),
  root!
);
