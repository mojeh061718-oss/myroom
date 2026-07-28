import { lazy, Suspense, useEffect, useState } from "react";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import { useSettings } from "./stores/settingsStore.js";
import { useProjects } from "./stores/projectsStore.js";
import { Splash } from "./screens/Splash.js";
import { Tutorial } from "./screens/Tutorial.js";
import { Home } from "./screens/Home.js";
import { DrawingBoard } from "./screens/board/DrawingBoard.js";
import { StubScreen } from "./screens/StubScreen.js";
import { ToastRegion } from "./components/Toast.js";

/**
 * The 3D sandbox pulls in three.js, so it is code-split: the splash, tutorial,
 * home and drawing board must not pay for it (docs/01 §2 cold-start budget).
 * The chunk is prefetched as soon as the app is idle, so opening a room still
 * hits the docs/06 §8 "< 2 s from tap on project card" budget.
 */
const Sandbox = lazy(() =>
  import("./screens/sandbox/Sandbox.js").then((m) => ({ default: m.Sandbox })),
);

function SandboxRoute() {
  return (
    <Suspense
      fallback={
        <div className="sandbox-loading" style={{ position: "fixed", inset: 0 }}>
          <span className="type-label">Building your room…</span>
        </div>
      }
    >
      <Sandbox />
    </Suspense>
  );
}

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
    { path: "/p/:id", element: <SandboxRoute /> },
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
    // Warm the 3D chunk once the app is idle so opening a room feels instant.
    const idle =
      typeof requestIdleCallback === "function"
        ? requestIdleCallback(() => void import("./screens/sandbox/Sandbox.js"))
        : setTimeout(() => void import("./screens/sandbox/Sandbox.js"), 1200);
    return () => {
      if (typeof cancelIdleCallback === "function" && typeof idle === "number") cancelIdleCallback(idle);
      else clearTimeout(idle as ReturnType<typeof setTimeout>);
    };
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
