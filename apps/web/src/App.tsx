import { useEffect, useState } from "react";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import { useSettings } from "./stores/settingsStore.js";
import { useProjects } from "./stores/projectsStore.js";
import { Splash } from "./screens/Splash.js";
import { Tutorial } from "./screens/Tutorial.js";
import { Home } from "./screens/Home.js";
import { DrawingBoard } from "./screens/board/DrawingBoard.js";
import { StubScreen } from "./screens/StubScreen.js";
import { ToastRegion } from "./components/Toast.js";

// BASE_URL follows Vite's `base`, so the app works at the domain root and
// under a staging subpath without route changes.
const router = createBrowserRouter(
  [
    { path: "/", element: <Home /> },
    { path: "/tutorial", element: <Tutorial /> },
    { path: "/p/:id/draw", element: <DrawingBoard /> },
    {
      path: "/p/:id/capture",
      element: (
        <StubScreen
          title="Guided photo capture"
          body="Photo capture and reconstruction arrive in Milestone M4. Your plan is saved — this room is ready for photos the moment the pipeline ships."
        />
      ),
    },
    {
      path: "/p/:id",
      element: (
        <StubScreen
          title="3D Sandbox"
          body="The 3D room shell arrives in Milestone M2. Your drawn plan is saved and will extrude into a navigable room."
        />
      ),
    },
  ],
  { basename: import.meta.env.BASE_URL },
);

export function App() {
  const settingsHydrated = useSettings((s) => s.hydrated);
  const hydrateSettings = useSettings((s) => s.hydrate);
  const hydrateProjects = useProjects((s) => s.hydrate);
  const [splashDone, setSplashDone] = useState(sessionStorage.getItem("splashShown") === "1");

  useEffect(() => {
    void hydrateSettings();
    void hydrateProjects();
  }, [hydrateSettings, hydrateProjects]);

  if (!splashDone || !settingsHydrated) {
    return (
      <Splash
        ready={settingsHydrated}
        onDone={() => {
          sessionStorage.setItem("splashShown", "1");
          setSplashDone(true);
        }}
      />
    );
  }

  return (
    <>
      <RouterProvider router={router} />
      <ToastRegion />
    </>
  );
}
