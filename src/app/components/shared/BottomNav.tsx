import { Home, History, Layers, Compass, Coins } from 'lucide-react';
import { Link, useLocation } from 'react-router';


const tabs = [
  { id: 'home', label: 'Home', icon: Home, path: '/app' },
  { id: 'rwa', label: 'Assets', icon: Coins, path: '/app/rwa' },
  { id: 'history', label: 'History', icon: History, path: '/app/history' },
  { id: 'stake', label: 'Stake', icon: Layers, path: '/app/stake' },
  { id: 'explore', label: 'Explore', icon: Compass, path: '/app/explore' },
];

export function BottomNav() {
  const location = useLocation();

  return (
    <div className="fixed bottom-0 left-0 right-0 bg-[#0a0a0a]/98 backdrop-blur-2xl border-t border-white/[0.08] z-50 pb-safe">
      <div className="max-w-lg mx-auto px-4 pt-3 pb-6">
        <div className="flex items-center justify-around">
          {tabs.map((tab) => {
            const isActive = location.pathname === tab.path || 
              (tab.path === '/app' && location.pathname === '/');
            const Icon = tab.icon;
            
            return (
              <Link
                key={tab.id}
                to={tab.path}
                className="flex flex-col items-center gap-1.5 py-1 min-w-[60px]"
              >
                <Icon
                  className={`w-6 h-6 transition-all duration-200 ${
                    isActive ? 'text-white' : 'text-white/40'
                  }`}
                  strokeWidth={isActive ? 2.5 : 2}
                />
                <span
                  className={`text-[10px] font-medium transition-all duration-200 ${
                    isActive ? 'text-white' : 'text-white/40'
                  }`}
                >
                  {tab.label}
                </span>
              </Link>
            );
          })}
        </div>
        
        {/* Home Indicator */}
        <div className="flex justify-center mt-3">
          
        </div>
      </div>
    </div>
  );
}