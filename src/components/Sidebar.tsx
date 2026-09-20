import React from 'react';
import {
  LayoutDashboard,
  GitMerge,
  Cpu,
  ListTodo,
  Activity,
  AlertTriangle,
  Settings,
  ShieldCheck,
} from 'lucide-react';
import { NavTab } from '../types/ui.ts';

interface SidebarProps {
  activeTab: NavTab;
  onTabChange: (tab: NavTab) => void;
  openAttentionCount: number;
}

export const Sidebar: React.FC<SidebarProps> = ({
  activeTab,
  onTabChange,
  openAttentionCount,
}) => {
  const navItems: { id: NavTab; label: string; icon: React.FC<{ className?: string }>; badge?: number }[] = [
    { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { id: 'pairs', label: 'Pairs & Projects', icon: GitMerge },
    { id: 'sessions', label: 'Runtime Sessions', icon: Cpu },
    { id: 'assignments', label: 'Assignments', icon: ListTodo },
    { id: 'timeline', label: 'Activity Timeline', icon: Activity },
    { id: 'attention', label: 'Attention & Recovery', icon: AlertTriangle, badge: openAttentionCount },
    { id: 'settings', label: 'Engine Settings', icon: Settings },
  ];

  return (
    <aside className="w-64 bg-slate-900 border-r border-slate-800 flex flex-col select-none">
      {/* Blank header space for mac controls */}
      <div className="h-12 border-b border-slate-800/80"></div>

      {/* Navigation */}
      <nav className="p-3 flex-1 space-y-1">
        <div className="px-3 py-1 text-[11px] font-medium uppercase text-slate-400">
          Orchestration
        </div>
        {navItems.map((item) => {
          const Icon = item.icon;
          const isActive = activeTab === item.id;
          return (
            <button
              key={item.id}
              id={`nav-tab-${item.id}`}
              onClick={() => onTabChange(item.id)}
              className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-sm transition-colors ${
                isActive
                  ? 'bg-blue-600/20 text-blue-400 font-medium border border-blue-500/30'
                  : 'text-slate-300 hover:bg-slate-800/60 hover:text-slate-100'
              }`}
            >
              <div className="flex items-center gap-2.5">
                <Icon className="w-4 h-4" />
                <span>{item.label}</span>
              </div>
              {item.badge && item.badge > 0 ? (
                <span className="px-1.5 py-0.5 text-xs font-semibold rounded-full bg-amber-500 text-slate-950">
                  {item.badge}
                </span>
              ) : null}
            </button>
          );
        })}
      </nav>

      {/* Engine Status Footer */}
      <div className="p-3 border-t border-slate-800 bg-slate-950/40">
        <div className="flex items-center gap-2 px-2 py-1.5 rounded bg-slate-900 border border-slate-800">
          <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium text-slate-200 truncate">Relay Engine v1.0</p>
            <p className="text-[11px] text-slate-400 truncate">SQLite Sync • Local macOS</p>
          </div>
          <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
        </div>
      </div>
    </aside>
  );
};
