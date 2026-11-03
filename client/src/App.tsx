import { Link, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { ChannelsPage } from "./pages/ChannelsPage";
import { SettingsPage } from "./pages/SettingsPage";

export function App() {
  const location = useLocation();
  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">ErsatzTV Promo Generator</div>
        <nav>
          <Link
            className={
              location.pathname.startsWith("/channels") ||
              location.pathname === "/"
                ? "active"
                : ""
            }
            to="/channels"
          >
            Channels
          </Link>
          <Link
            className={
              location.pathname.startsWith("/settings") ? "active" : ""
            }
            to="/settings"
          >
            Settings
          </Link>
        </nav>
      </header>
      <main>
        <Routes>
          <Route path="/" element={<Navigate to="/channels" replace />} />
          <Route path="/channels" element={<ChannelsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </main>
    </div>
  );
}
