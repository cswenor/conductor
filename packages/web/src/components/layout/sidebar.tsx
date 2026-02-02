import { Nav, NavHeader, NavFooter } from './nav';

export function Sidebar() {
  return (
    <aside className="flex h-screen w-64 flex-col border-r bg-card">
      <NavHeader />
      <div className="flex-1 overflow-auto px-3 py-2">
        <Nav />
      </div>
      <div className="px-3 py-4">
        <NavFooter />
      </div>
    </aside>
  );
}
