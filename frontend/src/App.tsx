import { useState } from 'react';
import AdminVerification from './components/AdminVerification';
import MyOrganization from './components/MyOrganization';

type View = 'admin' | 'mine';

function App() {
  const [view, setView] = useState<View>('admin');
  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: '2rem', maxWidth: 720, margin: '0 auto' }}>
      <h1>Food Waste Redistribution Platform</h1>
      <p>Frontend shell — Iteration 0</p>
      <p>
        Backend health: <code>GET /api/health</code>
      </p>
      <nav>
        <button type="button" onClick={() => setView('admin')} disabled={view === 'admin'}>
          Admin verification
        </button>{' '}
        <button type="button" onClick={() => setView('mine')} disabled={view === 'mine'}>
          My organization
        </button>
      </nav>
      {view === 'admin' ? <AdminVerification /> : <MyOrganization />}
      <p style={{ color: '#666', fontSize: '0.9rem' }}>
        Monorepo: frontend (React + Vite + TypeScript) · backend (Node + Express + TypeScript) · PostgreSQL + Prisma
      </p>
    </main>
  );
}

export default App;
